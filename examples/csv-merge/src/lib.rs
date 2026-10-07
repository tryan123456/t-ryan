#![deny(clippy::all)]

mod job;
mod scan;

use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi::{Env, Task};
use napi_derive::napi;

fn to_napi(e: std::io::Error) -> Error {
  Error::from_reason(e.to_string())
}

#[napi(object)]
pub struct OpenOptions {
  /// Leading columns that form the composite row key.
  pub row_key_cols: u32,
  /// Leading rows that form the composite column key.
  pub col_key_rows: u32,
  /// Worker threads for both passes. Defaults to min(cores, 8) natively and
  /// 4 under WASM, which cannot detect the core count; pass
  /// `Math.min(os.availableParallelism(), 8)` there.
  pub threads: Option<u32>,
  /// One name per file, used as the `@<alias>` suffix under `keepAll` and as
  /// the source name in conflict reports. Must be unique and non-empty.
  /// Defaults to the file name without extension (`#<n>` added on clashes).
  pub aliases: Option<Vec<String>>,
}

#[napi(object)]
pub struct FileInfo {
  pub path: String,
  pub alias: String,
  pub bytes: i64,
  pub rows: i64,
  pub value_cols: i64,
}

#[napi(object)]
pub struct PairConflict {
  /// Index into `files`; `a < b`.
  pub a: u32,
  pub b: u32,
  pub rows: i64,
  pub cols: i64,
  pub cells: f64,
}

#[napi(object)]
pub struct ConflictSummary {
  pub total_cells: f64,
  pub pairs: Vec<PairConflict>,
  pub files: Vec<FileInfo>,
  /// Output size before any `keepAll` suffix columns.
  pub out_rows: i64,
  pub out_value_cols: i64,
  /// Repeated keys inside a single file; the first occurrence is used.
  pub duplicate_row_keys: i64,
  pub duplicate_col_keys: i64,
  /// Number of row / column keys that take part in a conflict; page through
  /// them with `conflictRows` / `conflictCols`.
  pub conflict_rows: i64,
  pub conflict_cols: i64,
}

/// A conflicting row or column key. Cell `(r, c)` conflicts across
/// `r.sources ∩ c.sources` (when that has at least two entries).
#[napi(object)]
pub struct ConflictKey {
  /// The composite key, unquoted.
  pub key: Vec<String>,
  /// Aliases of the files this key conflicts across, in file order.
  pub sources: Vec<String>,
}

#[napi(object)]
pub struct MergeStats {
  pub rows: i64,
  pub cols: i64,
  pub bytes_written: i64,
  pub elapsed_ms: f64,
}

#[napi(string_enum = "camelCase")]
pub enum MergePolicy {
  /// Later files win; an empty cell never replaces a value.
  Overwrite,
  /// Conflicting columns from later files are kept as `<header>@<file>`.
  KeepAll,
}

#[napi]
pub struct MergeJob {
  inner: Arc<job::Job>,
  open_ms: f64,
}

#[napi]
impl MergeJob {
  /// Duration of pass 1 (indexing), in milliseconds.
  #[napi(getter)]
  pub fn open_ms(&self) -> f64 {
    self.open_ms
  }

  #[napi]
  pub fn conflicts(&self) -> ConflictSummary {
    let j = &self.inner;
    let pairs: Vec<PairConflict> = j
      .conflicts()
      .into_iter()
      .map(|p| PairConflict {
        a: p.a as u32,
        b: p.b as u32,
        rows: p.rows as i64,
        cols: p.cols as i64,
        cells: p.rows as f64 * p.cols as f64,
      })
      .collect();
    ConflictSummary {
      total_cells: pairs.iter().map(|p| p.cells).sum(),
      pairs,
      files: j
        .files
        .iter()
        .map(|f| FileInfo {
          path: f.path.clone(),
          alias: f.alias.clone(),
          bytes: f.bytes as i64,
          rows: f.row_off.len() as i64,
          value_cols: f.value_cols() as i64,
        })
        .collect(),
      out_rows: j.out_rows() as i64,
      out_value_cols: j.base_cols() as i64,
      duplicate_row_keys: j.duplicate_rows as i64,
      duplicate_col_keys: j.duplicate_cols as i64,
      conflict_rows: j.conflict_counts().0 as i64,
      conflict_cols: j.conflict_counts().1 as i64,
    }
  }

  /// Conflicting row keys `[offset, offset + limit)`, in output order. Reads
  /// each row's key back from its file, so cost is proportional to `limit`.
  #[napi(ts_return_type = "Promise<Array<ConflictKey>>")]
  pub fn conflict_rows(&self, offset: u32, limit: u32) -> AsyncTask<ConflictKeysTask> {
    AsyncTask::new(ConflictKeysTask { job: self.inner.clone(), rows: true, offset, limit })
  }

  /// Conflicting column keys `[offset, offset + limit)`, in output order.
  #[napi(ts_return_type = "Promise<Array<ConflictKey>>")]
  pub fn conflict_cols(&self, offset: u32, limit: u32) -> AsyncTask<ConflictKeysTask> {
    AsyncTask::new(ConflictKeysTask { job: self.inner.clone(), rows: false, offset, limit })
  }

  /// Pass 2. Writes to `<outPath>.partial` and renames on success. To abort,
  /// simply never call this.
  #[napi(ts_return_type = "Promise<MergeStats>")]
  pub fn merge(&self, out_path: String, policy: MergePolicy) -> AsyncTask<MergeTask> {
    AsyncTask::new(MergeTask {
      job: self.inner.clone(),
      out_path,
      policy: match policy {
        MergePolicy::Overwrite => job::Policy::Overwrite,
        MergePolicy::KeepAll => job::Policy::KeepAll,
      },
    })
  }
}

pub struct ConflictKeysTask {
  job: Arc<job::Job>,
  rows: bool,
  offset: u32,
  limit: u32,
}

impl Task for ConflictKeysTask {
  type Output = Vec<job::ConflictKey>;
  type JsValue = Vec<ConflictKey>;

  fn compute(&mut self) -> Result<Self::Output> {
    let (offset, limit) = (self.offset as usize, self.limit as usize);
    if self.rows {
      self.job.conflict_rows(offset, limit).map_err(to_napi)
    } else {
      Ok(self.job.conflict_cols(offset, limit))
    }
  }

  fn resolve(&mut self, _env: Env, keys: Self::Output) -> Result<Self::JsValue> {
    Ok(keys.into_iter().map(|k| ConflictKey { key: k.key, sources: k.sources }).collect())
  }
}

pub struct OpenTask {
  files: Vec<String>,
  aliases: Option<Vec<String>>,
  row_key_cols: usize,
  col_key_rows: usize,
  threads: usize,
}

impl Task for OpenTask {
  type Output = (job::Job, f64);
  type JsValue = MergeJob;

  fn compute(&mut self) -> Result<Self::Output> {
    let (job, ms) = job::timed(|| job::Job::open(&self.files, self.aliases.as_deref(), self.row_key_cols, self.col_key_rows, self.threads));
    Ok((job.map_err(to_napi)?, ms))
  }

  fn resolve(&mut self, _env: Env, (job, open_ms): Self::Output) -> Result<MergeJob> {
    Ok(MergeJob { inner: Arc::new(job), open_ms })
  }
}

pub struct MergeTask {
  job: Arc<job::Job>,
  out_path: String,
  policy: job::Policy,
}

impl Task for MergeTask {
  type Output = MergeStats;
  type JsValue = MergeStats;

  fn compute(&mut self) -> Result<MergeStats> {
    let (stats, ms) = job::timed(|| self.job.merge(&self.out_path, self.policy));
    let s = stats.map_err(to_napi)?;
    Ok(MergeStats {
      rows: s.rows as i64,
      cols: s.cols as i64,
      bytes_written: s.bytes_written as i64,
      elapsed_ms: ms,
    })
  }

  fn resolve(&mut self, _env: Env, output: MergeStats) -> Result<MergeStats> {
    Ok(output)
  }
}

/// Pass 1: index every file and compute key overlaps.
#[napi(ts_return_type = "Promise<MergeJob>")]
pub fn open_merge_job(files: Vec<String>, options: OpenOptions) -> AsyncTask<OpenTask> {
  let threads = options.threads.map(|t| t as usize).unwrap_or_else(job::default_threads);
  AsyncTask::new(OpenTask {
    row_key_cols: options.row_key_cols as usize,
    col_key_rows: options.col_key_rows as usize,
    threads,
    files,
    aliases: options.aliases,
  })
}

/// Current WebAssembly linear memory size in bytes (0 when native). Linear
/// memory never shrinks, so this is also the peak.
#[napi]
pub fn wasm_memory_bytes() -> f64 {
  #[cfg(target_arch = "wasm32")]
  {
    (core::arch::wasm32::memory_size::<0>() * 65536) as f64
  }
  #[cfg(not(target_arch = "wasm32"))]
  {
    0.0
  }
}
