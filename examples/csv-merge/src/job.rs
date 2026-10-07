//! Two-pass merge of 2-D CSV files keyed by (row key, column key).
//!
//! Pass 1 (`Job::open`) only indexes keys: per row a hash plus byte offset,
//! per column a hash. Cell values never enter memory. Conflicts are derived
//! from row/column key intersections without reading any cell.
//!
//! Pass 2 (`Job::merge`) streams output row by row, seeking back into the
//! sources for the records that make up each output row.
//!
//! Rows are addressed by a global index `g = file_base[file] + row_in_file`,
//! which keeps every per-row structure at 4 bytes per entry.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::hash::{BuildHasherDefault, Hasher};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Condvar, Mutex};
use std::time::Instant;

use hashbrown::HashTable;

use crate::scan::{self, KeyHasher, Range, RecordReader};

const NONE: u32 = u32::MAX;
const READ_BUF: usize = 4 << 20;
const MAX_FILES: usize = 64;
/// Target size of one rendered batch of output rows in pass 2.
const BATCH_BYTES: usize = 4 << 20;
const WINDOW_PER_THREAD: usize = 2;

/// Keys are already xxh3 output, so the map can use them directly.
#[derive(Default)]
struct IdHasher(u64);

impl Hasher for IdHasher {
  fn finish(&self) -> u64 {
    self.0
  }
  fn write(&mut self, bytes: &[u8]) {
    for &b in bytes {
      self.0 = self.0.rotate_left(8) ^ b as u64;
    }
  }
  fn write_u128(&mut self, v: u128) {
    self.0 = v as u64;
  }
}

type KeyMap<V> = HashMap<u128, V, BuildHasherDefault<IdHasher>>;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Policy {
  Overwrite,
  KeepAll,
}

struct Header {
  rec: Vec<u8>,
  fields: Vec<Range>,
}

pub struct FileIndex {
  pub path: String,
  /// Source name: the caller's alias, or the file stem by default. Used as
  /// the `@<alias>` suffix and in conflict reports.
  pub alias: String,
  pub bytes: u64,
  headers: Vec<Header>,
  /// Base column id (deduplicated across files) of each value column.
  col_base: Vec<u32>,
  /// Start offset of each data record. A record spans up to the next offset
  /// (or EOF); trailing line endings are trimmed when it is read back.
  pub row_off: Vec<u64>,
}

impl FileIndex {
  pub fn value_cols(&self) -> usize {
    self.col_base.len()
  }

  fn row_span(&self, ri: usize) -> (u64, usize) {
    let off = self.row_off[ri];
    let end = self.row_off.get(ri + 1).copied().unwrap_or(self.bytes);
    (off, (end - off) as usize)
  }
}

pub struct Job {
  m: usize,
  n: usize,
  threads: usize,
  pub files: Vec<FileIndex>,
  /// Global row index of each file's first row, plus the total at the end.
  file_base: Vec<u32>,
  /// CSR: output row `o` is made of global rows `row_src[row_start[o]..row_start[o + 1]]`,
  /// in file order.
  row_start: Vec<u32>,
  row_src: Vec<u32>,
  /// Bitmask of files that contain each base column.
  col_files: Vec<u64>,
  /// Pairwise `F × F` counts of shared row keys / column keys.
  row_overlap: Vec<u64>,
  col_overlap: Vec<u64>,
  pub duplicate_rows: u64,
  pub duplicate_cols: u64,
  /// Output rows / base columns that take part in at least one conflict.
  conflict_rows: Vec<u32>,
  conflict_cols: Vec<u32>,
  /// First `(file, value column)` of each base column, for its header text.
  col_first: Vec<(u32, u32)>,
}

/// A conflicting row or column key and the sources (aliases) it conflicts
/// across. Cell `(r, c)` conflicts across `r.sources ∩ c.sources`.
pub struct ConflictKey {
  pub key: Vec<String>,
  pub sources: Vec<String>,
}

pub struct PairConflict {
  pub a: usize,
  pub b: usize,
  pub rows: u64,
  pub cols: u64,
}

pub struct MergeStats {
  pub rows: u64,
  pub cols: u64,
  pub bytes_written: u64,
}

fn invalid(msg: String) -> io::Error {
  io::Error::new(io::ErrorKind::InvalidData, msg)
}

fn file_of(file_base: &[u32], g: u32) -> usize {
  file_base.partition_point(|&b| b <= g) - 1
}

/// Pass 1 for a single file. Returns the index plus each value column's key
/// hash and each row's key hash (both consumed by `Job::open`).
fn index_file(path: &str, m: usize, n: usize) -> io::Result<(FileIndex, Vec<u128>, Vec<u128>)> {
  let file = File::open(path).map_err(|e| io::Error::new(e.kind(), format!("{path}: {e}")))?;
  let bytes = file.metadata()?.len();
  let mut reader = RecordReader::new(file, READ_BUF);
  let mut fields = Vec::new();

  let mut headers: Vec<Header> = Vec::with_capacity(n);
  for level in 0..n {
    let (off, rec) = reader
      .next_record()?
      .ok_or_else(|| invalid(format!("{path}: expected {n} header rows")))?;
    let rec = if off == 0 { scan::strip_bom(rec) } else { rec };
    scan::split_fields(rec, usize::MAX, &mut fields);
    if level > 0 && fields.len() != headers[0].fields.len() {
      return Err(invalid(format!("{path}: header row {level} has a different column count")));
    }
    headers.push(Header { rec: rec.to_vec(), fields: fields.clone() });
  }
  let ncols = headers[0].fields.len();
  if ncols <= m {
    return Err(invalid(format!("{path}: no value columns after {m} key columns")));
  }

  let col_hash: Vec<u128> = (m..ncols)
    .map(|j| {
      let mut h = KeyHasher::new();
      for hd in &headers {
        h.part(scan::field(&hd.rec, hd.fields[j]));
      }
      h.finish()
    })
    .collect();

  const SAMPLE: usize = 4096;
  let mut row_hash: Vec<u128> = Vec::new();
  let mut row_off: Vec<u64> = Vec::new();
  while let Some((off, rec)) = reader.next_record()? {
    if rec.is_empty() {
      continue;
    }
    // Size the vectors once from the average row length instead of letting
    // them double, which would briefly hold old + new buffers.
    if row_off.len() == SAMPLE {
      let avg = ((off - row_off[0]) / SAMPLE as u64).max(1);
      let estimate = ((bytes - row_off[0]) / avg) as usize;
      let extra = (estimate + estimate / 32).saturating_sub(row_off.len());
      row_off.reserve_exact(extra);
      row_hash.reserve_exact(extra);
    }
    scan::split_fields(rec, m, &mut fields);
    let mut h = KeyHasher::new();
    for &r in &fields {
      h.part(scan::field(rec, r));
    }
    row_hash.push(h.finish());
    row_off.push(off);
  }

  let alias = Path::new(path)
    .file_stem()
    .map(|s| s.to_string_lossy().into_owned())
    .unwrap_or_else(|| path.to_string());

  Ok((
    FileIndex {
      path: path.to_string(),
      alias,
      bytes,
      headers,
      col_base: Vec::new(),
      row_off,
    },
    col_hash,
    row_hash,
  ))
}

/// Files in `mask` that share at least one key of the other dimension with
/// another file in `mask` (per `overlap`), i.e. the files a key conflicts across.
fn participants(mask: u64, f: usize, overlap: &[u64]) -> u64 {
  let mut out = 0;
  pairs(mask, f, |a, b| {
    if overlap[a * f + b] > 0 {
      out |= 1 << a | 1 << b;
    }
  });
  out
}

fn utf8(raw: &[u8]) -> String {
  String::from_utf8_lossy(&scan::unquote(raw)).into_owned()
}

fn pairs(mask: u64, f: usize, mut visit: impl FnMut(usize, usize)) {
  for a in 0..f {
    if mask & (1 << a) == 0 {
      continue;
    }
    for b in a + 1..f {
      if mask & (1 << b) != 0 {
        visit(a, b);
      }
    }
  }
}

impl Job {
  pub fn open(paths: &[String], aliases: Option<&[String]>, m: usize, n: usize, threads: usize) -> io::Result<Job> {
    if paths.is_empty() || paths.len() > MAX_FILES {
      return Err(invalid(format!("expected 1..={MAX_FILES} files")));
    }
    if n == 0 {
      return Err(invalid("colKeyRows must be at least 1".into()));
    }
    let f = paths.len();
    if let Some(aliases) = aliases {
      if aliases.len() != f {
        return Err(invalid(format!("aliases: expected {f} entries, got {}", aliases.len())));
      }
      for (i, a) in aliases.iter().enumerate() {
        if a.is_empty() {
          return Err(invalid(format!("aliases[{i}] is empty")));
        }
        if aliases[..i].contains(a) {
          return Err(invalid(format!("aliases[{i}] duplicates \"{a}\"")));
        }
      }
    }

    // Pass 1, files in parallel.
    let mut results: Vec<Option<io::Result<_>>> = (0..f).map(|_| None).collect();
    let per_thread = f.div_ceil(threads.clamp(1, f));
    std::thread::scope(|s| {
      for (chunk_idx, chunk) in results.chunks_mut(per_thread).enumerate() {
        let base = chunk_idx * per_thread;
        s.spawn(move || {
          for (i, slot) in chunk.iter_mut().enumerate() {
            *slot = Some(index_file(&paths[base + i], m, n));
          }
        });
      }
    });

    let mut files = Vec::with_capacity(f);
    let mut col_hashes = Vec::with_capacity(f);
    let mut row_hashes = Vec::with_capacity(f);
    for r in results {
      let (idx, ch, rh) = r.unwrap()?;
      files.push(idx);
      col_hashes.push(ch);
      row_hashes.push(rh);
    }

    match aliases {
      Some(aliases) => {
        for (file, a) in files.iter_mut().zip(aliases) {
          file.alias = a.clone();
        }
      }
      // Make default names unique so suffixed columns stay distinguishable.
      None => {
        for i in 0..f {
          if files[..i].iter().any(|o| o.alias == files[i].alias) {
            files[i].alias = format!("{}#{}", files[i].alias, i + 1);
          }
        }
      }
    }

    let mut file_base = Vec::with_capacity(f + 1);
    let mut total: u64 = 0;
    for rh in &row_hashes {
      file_base.push(total as u32);
      total += rh.len() as u64;
    }
    if total >= NONE as u64 {
      return Err(invalid(format!("too many rows ({total})")));
    }
    file_base.push(total as u32);
    let total = total as usize;

    // Assign output rows in first-appearance order. The table stores only the
    // global index of each key's first row; its hash is looked up on demand.
    let hash_of = |g: u32| -> u128 {
      let fi = file_of(&file_base, g);
      row_hashes[fi][(g - file_base[fi]) as usize]
    };
    let mut table: HashTable<u32> = HashTable::with_capacity(total);
    let mut row_out: Vec<u32> = Vec::with_capacity(total);
    let mut last_file: Vec<u8> = Vec::new();
    let mut duplicate_rows = 0;
    for (fi, hashes) in row_hashes.iter().enumerate() {
      for (ri, &h) in hashes.iter().enumerate() {
        let g = file_base[fi] + ri as u32;
        match table.find(h as u64, |&e| hash_of(e) == h) {
          Some(&first) => {
            let o = row_out[first as usize];
            if last_file[o as usize] as usize == fi {
              duplicate_rows += 1;
              row_out.push(NONE);
            } else {
              last_file[o as usize] = fi as u8;
              row_out.push(o);
            }
          }
          None => {
            table.insert_unique(h as u64, g, |&e| hash_of(e) as u64);
            row_out.push(last_file.len() as u32);
            last_file.push(fi as u8);
          }
        }
      }
    }
    let out_rows = last_file.len();
    drop(table);
    drop(last_file);
    drop(row_hashes);

    // Invert row_out into CSR. Iterating g in order keeps each output row's
    // sources in file order.
    let mut row_start = vec![0u32; out_rows + 1];
    for &o in &row_out {
      if o != NONE {
        row_start[o as usize + 1] += 1;
      }
    }
    for i in 0..out_rows {
      row_start[i + 1] += row_start[i];
    }
    let mut cursor = row_start.clone();
    let mut row_src = vec![0u32; row_start[out_rows] as usize];
    for (g, &o) in row_out.iter().enumerate() {
      if o != NONE {
        row_src[cursor[o as usize] as usize] = g as u32;
        cursor[o as usize] += 1;
      }
    }
    drop(cursor);
    drop(row_out);

    let mut row_overlap = vec![0u64; f * f];
    for o in 0..out_rows {
      let srcs = &row_src[row_start[o] as usize..row_start[o + 1] as usize];
      if srcs.len() > 1 {
        let mask = srcs.iter().fold(0u64, |acc, &g| acc | 1 << file_of(&file_base, g));
        pairs(mask, f, |a, b| row_overlap[a * f + b] += 1);
      }
    }

    // Global column table.
    let mut col_ids: KeyMap<u32> = KeyMap::default();
    let mut col_files: Vec<u64> = Vec::new();
    let mut col_first: Vec<(u32, u32)> = Vec::new();
    let mut duplicate_cols = 0;
    for (fi, hashes) in col_hashes.iter().enumerate() {
      let mut base = Vec::with_capacity(hashes.len());
      for (j, &h) in hashes.iter().enumerate() {
        let next = col_files.len() as u32;
        let id = *col_ids.entry(h).or_insert_with(|| {
          col_files.push(0);
          col_first.push((fi as u32, j as u32));
          next
        });
        if col_files[id as usize] & (1 << fi) != 0 {
          duplicate_cols += 1;
        }
        col_files[id as usize] |= 1 << fi;
        base.push(id);
      }
      files[fi].col_base = base;
    }
    let mut col_overlap = vec![0u64; f * f];
    for &mask in &col_files {
      if mask.count_ones() > 1 {
        pairs(mask, f, |a, b| col_overlap[a * f + b] += 1);
      }
    }

    // Keys that take part in a conflict. Only ids are kept; key text is
    // produced on request (columns from the headers, rows by re-reading).
    let row_mask = |o: usize| {
      row_src[row_start[o] as usize..row_start[o + 1] as usize]
        .iter()
        .fold(0u64, |acc, &g| acc | 1 << file_of(&file_base, g))
    };
    let conflict_rows: Vec<u32> = (0..out_rows)
      .filter(|&o| row_start[o + 1] - row_start[o] > 1 && participants(row_mask(o), f, &col_overlap) != 0)
      .map(|o| o as u32)
      .collect();
    let conflict_cols: Vec<u32> = (0..col_files.len())
      .filter(|&b| col_files[b].count_ones() > 1 && participants(col_files[b], f, &row_overlap) != 0)
      .map(|b| b as u32)
      .collect();

    Ok(Job {
      m,
      n,
      threads,
      files,
      file_base,
      row_start,
      row_src,
      col_files,
      row_overlap,
      col_overlap,
      duplicate_rows,
      duplicate_cols,
      conflict_rows,
      conflict_cols,
      col_first,
    })
  }

  pub fn conflict_counts(&self) -> (usize, usize) {
    (self.conflict_rows.len(), self.conflict_cols.len())
  }

  fn aliases_of(&self, mask: u64) -> Vec<String> {
    (0..self.files.len())
      .filter(|&fi| mask & (1 << fi) != 0)
      .map(|fi| self.files[fi].alias.clone())
      .collect()
  }

  fn row_mask(&self, o: usize) -> u64 {
    self.row_sources(o).iter().fold(0u64, |acc, &g| acc | 1 << file_of(&self.file_base, g))
  }

  /// Conflicting column keys `[offset, offset + limit)`, in output order.
  pub fn conflict_cols(&self, offset: usize, limit: usize) -> Vec<ConflictKey> {
    let f = self.files.len();
    let ids = &self.conflict_cols[offset.min(self.conflict_cols.len())..offset.saturating_add(limit).min(self.conflict_cols.len())];
    ids
      .iter()
      .map(|&bid| {
        let (fi, j) = self.col_first[bid as usize];
        let file = &self.files[fi as usize];
        ConflictKey {
          key: file
            .headers
            .iter()
            .map(|h| utf8(scan::field(&h.rec, h.fields[self.m + j as usize])))
            .collect(),
          sources: self.aliases_of(participants(self.col_files[bid as usize], f, &self.row_overlap)),
        }
      })
      .collect()
  }

  /// Conflicting row keys `[offset, offset + limit)`, in output order. Key
  /// text is re-read from the first file containing each row.
  pub fn conflict_rows(&self, offset: usize, limit: usize) -> io::Result<Vec<ConflictKey>> {
    let f = self.files.len();
    let ids = &self.conflict_rows[offset.min(self.conflict_rows.len())..offset.saturating_add(limit).min(self.conflict_rows.len())];
    let mut readers: Vec<Option<(BufReader<File>, u64)>> = (0..f).map(|_| None).collect();
    let mut buf = Vec::new();
    let mut fields = Vec::new();
    let mut out = Vec::with_capacity(ids.len());
    for &o in ids {
      let o = o as usize;
      let g = self.row_sources(o)[0];
      let fi = file_of(&self.file_base, g);
      let (off, span) = self.files[fi].row_span((g - self.file_base[fi]) as usize);
      if readers[fi].is_none() {
        readers[fi] = Some((BufReader::with_capacity(64 << 10, File::open(&self.files[fi].path)?), 0));
      }
      let (reader, pos) = readers[fi].as_mut().unwrap();
      if off != *pos {
        reader.seek_relative(off as i64 - *pos as i64)?;
      }
      buf.resize(span, 0);
      reader.read_exact(&mut buf)?;
      *pos = off + span as u64;
      let rec = scan::trim_eol(&buf);
      scan::split_fields(rec, self.m, &mut fields);
      let mut key: Vec<String> = fields.iter().map(|&r| utf8(scan::field(rec, r))).collect();
      key.resize(self.m, String::new());
      out.push(ConflictKey {
        key,
        sources: self.aliases_of(participants(self.row_mask(o), f, &self.col_overlap)),
      });
    }
    Ok(out)
  }

  pub fn out_rows(&self) -> usize {
    self.row_start.len() - 1
  }

  pub fn base_cols(&self) -> usize {
    self.col_files.len()
  }

  /// A cell conflicts when both its row key and column key exist in two
  /// files, so per file pair the conflicting cells are rows∩ × cols∩.
  pub fn conflicts(&self) -> Vec<PairConflict> {
    let f = self.files.len();
    let mut out = Vec::new();
    for a in 0..f {
      for b in a + 1..f {
        let rows = self.row_overlap[a * f + b];
        let cols = self.col_overlap[a * f + b];
        if rows > 0 && cols > 0 {
          out.push(PairConflict { a, b, rows, cols });
        }
      }
    }
    out
  }

  pub fn merge(&self, out_path: &str, policy: Policy) -> io::Result<MergeStats> {
    let layout = self.layout(policy);
    let tmp_path = format!("{out_path}.partial");
    let result = self.write_output(&tmp_path, &layout);
    match result {
      Ok(stats) => {
        fs::rename(&tmp_path, out_path)?;
        Ok(stats)
      }
      Err(e) => {
        let _ = fs::remove_file(&tmp_path);
        Err(e)
      }
    }
  }

  /// Output column layout, in first-appearance order. Under KeepAll a column
  /// that conflicts with an earlier file gets its own suffixed copy.
  fn layout(&self, policy: Policy) -> Layout {
    let f = self.files.len();
    let mut out_cols: Vec<OutCol> = Vec::new();
    let mut base_out = vec![NONE; self.base_cols()];
    let mut col_map: Vec<Vec<u32>> = Vec::with_capacity(f);
    for (fi, file) in self.files.iter().enumerate() {
      let mut map = Vec::with_capacity(file.value_cols());
      for (j, &bid) in file.col_base.iter().enumerate() {
        let bid = bid as usize;
        let conflicts = policy == Policy::KeepAll
          && base_out[bid] != NONE
          && (0..fi).any(|g| self.col_files[bid] & (1 << g) != 0 && self.row_overlap[g * f + fi] > 0);
        let target = if base_out[bid] == NONE || conflicts {
          out_cols.push(OutCol { file: fi as u32, col: j as u32, suffixed: conflicts });
          let id = (out_cols.len() - 1) as u32;
          if base_out[bid] == NONE {
            base_out[bid] = id;
          }
          id
        } else {
          base_out[bid]
        };
        map.push(target);
      }
      col_map.push(map);
    }

    // Invert to: output column → contributing (file, column), in file order.
    let mut src_start = vec![0u32; out_cols.len() + 1];
    for map in &col_map {
      for &c in map {
        src_start[c as usize + 1] += 1;
      }
    }
    for i in 0..out_cols.len() {
      src_start[i + 1] += src_start[i];
    }
    let mut fill = src_start.clone();
    let mut sources = vec![(0u32, 0u32); src_start[out_cols.len()] as usize];
    for (fi, map) in col_map.iter().enumerate() {
      for (j, &c) in map.iter().enumerate() {
        sources[fill[c as usize] as usize] = (fi as u32, (self.m + j) as u32);
        fill[c as usize] += 1;
      }
    }
    Layout { out_cols, src_start, sources }
  }

  fn write_header(&self, layout: &Layout, line: &mut Vec<u8>) {
    let (m, n) = (self.m, self.n);
    for level in 0..n {
      let corner = &self.files[0].headers[level];
      for k in 0..m {
        if k > 0 {
          line.push(b',');
        }
        line.extend_from_slice(scan::field(&corner.rec, corner.fields[k]));
      }
      for oc in &layout.out_cols {
        let file = &self.files[oc.file as usize];
        let hd = &file.headers[level];
        let raw = scan::field(&hd.rec, hd.fields[m + oc.col as usize]);
        line.push(b',');
        if oc.suffixed && level == n - 1 {
          let mut v = scan::unquote(raw).into_owned();
          v.push(b'@');
          v.extend_from_slice(file.alias.as_bytes());
          scan::write_escaped(line, &v);
        } else {
          line.extend_from_slice(raw);
        }
      }
      line.push(b'\n');
    }
  }

  fn row_sources(&self, o: usize) -> &[u32] {
    &self.row_src[self.row_start[o] as usize..self.row_start[o + 1] as usize]
  }

  /// Splits output rows into contiguous batches of roughly `BATCH_BYTES`
  /// of output, estimated from source record sizes.
  fn batches(&self, layout: &Layout) -> Vec<usize> {
    let mut bounds = vec![0];
    let mut acc = 0usize;
    for o in 0..self.out_rows() {
      acc += layout.out_cols.len();
      for &g in self.row_sources(o) {
        let fi = file_of(&self.file_base, g);
        acc += self.files[fi].row_span((g - self.file_base[fi]) as usize).1;
      }
      if acc >= BATCH_BYTES {
        bounds.push(o + 1);
        acc = 0;
      }
    }
    if *bounds.last().unwrap() != self.out_rows() {
      bounds.push(self.out_rows());
    }
    bounds
  }

  /// Pass 2. Workers render batches of rows in parallel; this thread writes
  /// them in order. At most `WINDOW_PER_THREAD × threads` rendered batches
  /// exist at once, which bounds memory regardless of output size.
  fn write_output(&self, path: &str, layout: &Layout) -> io::Result<MergeStats> {
    let mut w = BufWriter::with_capacity(1 << 20, File::create(path)?);
    let mut header = Vec::new();
    self.write_header(layout, &mut header);
    w.write_all(&header)?;
    let mut written = header.len() as u64;
    drop(header);

    let bounds = self.batches(layout);
    let batches = bounds.len() - 1;
    let threads = self.threads.clamp(1, batches.max(1));
    let window = threads * WINDOW_PER_THREAD;
    let next_batch = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);
    let gate = (Mutex::new(0usize), Condvar::new());

    let result = std::thread::scope(|s| -> io::Result<()> {
      let (tx, rx) = mpsc::sync_channel::<Rendered>(window);
      for _ in 0..threads {
        let tx = tx.clone();
        let (bounds, next_batch, stop, gate) = (&bounds, &next_batch, &stop, &gate);
        s.spawn(move || {
          let mut state = match RenderState::new(&self.files) {
            Ok(st) => st,
            Err(e) => {
              let _ = tx.send((usize::MAX, Err(e)));
              return;
            }
          };
          loop {
            let b = next_batch.fetch_add(1, Ordering::Relaxed);
            if b >= batches {
              return;
            }
            {
              let mut done = gate.0.lock().unwrap();
              while b >= *done + window && !stop.load(Ordering::Relaxed) {
                done = gate.1.wait(done).unwrap();
              }
            }
            if stop.load(Ordering::Relaxed) {
              return;
            }
            let mut out = Vec::with_capacity(BATCH_BYTES + BATCH_BYTES / 4);
            let r = (bounds[b]..bounds[b + 1])
              .try_for_each(|o| self.render_row(layout, o, &mut state, &mut out))
              .map(|_| out);
            if tx.send((b, r)).is_err() {
              return;
            }
          }
        });
      }
      drop(tx);

      let r = drain_in_order(rx, &mut w, &mut written, &gate);
      // Unblock any worker still waiting for window space. Set under the lock
      // so a worker cannot miss the wakeup between its check and `wait`.
      {
        let _guard = gate.0.lock().unwrap();
        stop.store(true, Ordering::Relaxed);
      }
      gate.1.notify_all();
      r
    });
    result?;

    Ok(MergeStats {
      rows: self.out_rows() as u64,
      cols: (self.m + layout.out_cols.len()) as u64,
      bytes_written: written,
    })
  }

  fn render_row(&self, layout: &Layout, o: usize, st: &mut RenderState, line: &mut Vec<u8>) -> io::Result<()> {
    st.present.fill(false);
    let srcs = self.row_sources(o);
    for &g in srcs {
      let fi = file_of(&self.file_base, g);
      let (off, span) = self.files[fi].row_span((g - self.file_base[fi]) as usize);
      if off != st.pos[fi] {
        st.readers[fi].seek_relative(off as i64 - st.pos[fi] as i64)?;
      }
      let buf = &mut st.bufs[fi];
      buf.resize(span, 0);
      st.readers[fi].read_exact(buf)?;
      st.pos[fi] = off + span as u64;
      let rec = scan::trim_eol(buf);
      st.lens[fi] = rec.len();
      scan::split_fields(rec, usize::MAX, &mut st.fields[fi]);
      st.present[fi] = true;
    }

    let kf = file_of(&self.file_base, srcs[0]);
    for k in 0..self.m {
      if k > 0 {
        line.push(b',');
      }
      if let Some(&r) = st.fields[kf].get(k) {
        line.extend_from_slice(scan::field(&st.bufs[kf], r));
      }
    }
    for c in 0..layout.out_cols.len() {
      line.push(b',');
      // Latest file wins; an empty cell never overwrites a value.
      let srcs = &layout.sources[layout.src_start[c] as usize..layout.src_start[c + 1] as usize];
      for &(sf, sc) in srcs.iter().rev() {
        let sf = sf as usize;
        if !st.present[sf] {
          continue;
        }
        if let Some(&r) = st.fields[sf].get(sc as usize) {
          let raw = scan::field(&st.bufs[sf][..st.lens[sf]], r);
          if !scan::is_empty(raw) {
            line.extend_from_slice(raw);
            break;
          }
        }
      }
    }
    line.push(b'\n');
    Ok(())
  }
}

struct OutCol {
  file: u32,
  col: u32,
  suffixed: bool,
}

struct Layout {
  out_cols: Vec<OutCol>,
  src_start: Vec<u32>,
  sources: Vec<(u32, u32)>,
}

/// Per-worker read state: one reader per source file, so rows that are
/// sequential within a file stay sequential reads.
struct RenderState {
  readers: Vec<BufReader<File>>,
  pos: Vec<u64>,
  bufs: Vec<Vec<u8>>,
  lens: Vec<usize>,
  fields: Vec<Vec<Range>>,
  present: Vec<bool>,
}

impl RenderState {
  fn new(files: &[FileIndex]) -> io::Result<Self> {
    let f = files.len();
    Ok(Self {
      readers: files
        .iter()
        .map(|fi| File::open(&fi.path).map(|h| BufReader::with_capacity(256 << 10, h)))
        .collect::<io::Result<_>>()?,
      pos: vec![0; f],
      bufs: vec![Vec::new(); f],
      lens: vec![0; f],
      fields: vec![Vec::new(); f],
      present: vec![false; f],
    })
  }
}

type Rendered = (usize, io::Result<Vec<u8>>);

/// Writes rendered batches in batch order. Takes `rx` by value so that an
/// early error drops it, which unblocks workers stuck in `send`.
fn drain_in_order(
  rx: mpsc::Receiver<Rendered>,
  w: &mut impl Write,
  written: &mut u64,
  gate: &(Mutex<usize>, Condvar),
) -> io::Result<()> {
  let mut pending: BTreeMap<usize, Vec<u8>> = BTreeMap::new();
  let mut next = 0;
  for (b, r) in rx {
    pending.insert(b, r?);
    while let Some(buf) = pending.remove(&next) {
      w.write_all(&buf)?;
      *written += buf.len() as u64;
      next += 1;
      *gate.0.lock().unwrap() = next;
      gate.1.notify_all();
    }
  }
  w.flush()
}

/// WASI cannot see the host's cores (`available_parallelism` reports 1), so
/// WASM falls back to a fixed count; callers should pass `threads` there.
pub fn default_threads() -> usize {
  if cfg!(target_arch = "wasm32") {
    return 4;
  }
  std::thread::available_parallelism().map(|n| n.get().min(8)).unwrap_or(4)
}


pub fn timed<T>(f: impl FnOnce() -> T) -> (T, f64) {
  let t = Instant::now();
  let v = f();
  (v, t.elapsed().as_secs_f64() * 1000.0)
}
