//! RFC 4180 CSV scanning primitives.
//!
//! Fields are kept in their raw (still-quoted) form so they can be copied to
//! the output verbatim; `unquote` is only used where the logical value matters
//! (key hashing, header suffixing).

use std::borrow::Cow;
use std::io::{self, Read};

use memchr::{memchr, memchr2};
use xxhash_rust::xxh3::Xxh3;

pub type Range = (u32, u32);

/// Length of the record at the start of `buf`, including its trailing `\n`.
/// `None` when the record is not terminated within `buf`.
///
/// A `""` escape inside a quoted field toggles the quote state twice, so
/// simple parity tracking is enough.
pub fn find_record_end(buf: &[u8]) -> Option<usize> {
  let mut i = 0;
  let mut in_quote = false;
  loop {
    if in_quote {
      let p = memchr(b'"', &buf[i..])?;
      i += p + 1;
      in_quote = false;
    } else {
      let p = memchr2(b'"', b'\n', &buf[i..])?;
      let c = buf[i + p];
      i += p + 1;
      if c == b'\n' {
        return Some(i);
      }
      in_quote = true;
    }
  }
}

pub fn trim_eol(rec: &[u8]) -> &[u8] {
  let mut end = rec.len();
  while end > 0 && (rec[end - 1] == b'\n' || rec[end - 1] == b'\r') {
    end -= 1;
  }
  &rec[..end]
}

/// Streams records out of a reader, tracking each record's file offset.
pub struct RecordReader<R: Read> {
  src: R,
  buf: Vec<u8>,
  start: usize,
  end: usize,
  base: u64,
  eof: bool,
}

impl<R: Read> RecordReader<R> {
  pub fn new(src: R, capacity: usize) -> Self {
    Self {
      src,
      buf: vec![0; capacity],
      start: 0,
      end: 0,
      base: 0,
      eof: false,
    }
  }

  /// Next record as `(offset, bytes without line ending)`.
  pub fn next_record(&mut self) -> io::Result<Option<(u64, &[u8])>> {
    loop {
      if let Some(len) = find_record_end(&self.buf[self.start..self.end]) {
        let s = self.start;
        self.start += len;
        return Ok(Some((self.base + s as u64, trim_eol(&self.buf[s..s + len]))));
      }
      if self.eof {
        if self.start == self.end {
          return Ok(None);
        }
        let s = self.start;
        self.start = self.end;
        return Ok(Some((self.base + s as u64, trim_eol(&self.buf[s..self.end]))));
      }
      self.refill()?;
    }
  }

  fn refill(&mut self) -> io::Result<()> {
    if self.start > 0 {
      self.buf.copy_within(self.start..self.end, 0);
      self.base += self.start as u64;
      self.end -= self.start;
      self.start = 0;
    }
    if self.end == self.buf.len() {
      // A single record is larger than the buffer.
      let len = self.buf.len();
      self.buf.resize(len * 2, 0);
    }
    let n = self.src.read(&mut self.buf[self.end..])?;
    if n == 0 {
      self.eof = true;
    }
    self.end += n;
    Ok(())
  }
}

/// Splits up to `max` raw fields of `rec` into `out`.
pub fn split_fields(rec: &[u8], max: usize, out: &mut Vec<Range>) {
  out.clear();
  let mut start = 0usize;
  let mut i = 0usize;
  let mut in_quote = false;
  while out.len() < max {
    if in_quote {
      match memchr(b'"', &rec[i..]) {
        Some(p) => {
          i += p + 1;
          in_quote = false;
        }
        None => break,
      }
    } else {
      match memchr2(b',', b'"', &rec[i..]) {
        Some(p) if rec[i + p] == b',' => {
          out.push((start as u32, (i + p) as u32));
          i += p + 1;
          start = i;
        }
        Some(p) => {
          i += p + 1;
          in_quote = true;
        }
        None => break,
      }
    }
  }
  if out.len() < max {
    out.push((start as u32, rec.len() as u32));
  }
}

#[inline]
pub fn field(rec: &[u8], r: Range) -> &[u8] {
  &rec[r.0 as usize..r.1 as usize]
}

#[inline]
pub fn is_empty(raw: &[u8]) -> bool {
  raw.is_empty() || raw == b"\"\""
}

pub fn unquote(raw: &[u8]) -> Cow<'_, [u8]> {
  if raw.len() >= 2 && raw[0] == b'"' && raw[raw.len() - 1] == b'"' {
    let inner = &raw[1..raw.len() - 1];
    if memchr(b'"', inner).is_none() {
      return Cow::Borrowed(inner);
    }
    let mut v = Vec::with_capacity(inner.len());
    let mut i = 0;
    while i < inner.len() {
      v.push(inner[i]);
      i += if inner[i] == b'"' { 2 } else { 1 };
    }
    return Cow::Owned(v);
  }
  Cow::Borrowed(raw)
}

pub fn write_escaped(out: &mut Vec<u8>, value: &[u8]) {
  if value.iter().any(|&c| matches!(c, b',' | b'"' | b'\n' | b'\r')) {
    out.push(b'"');
    for &c in value {
      if c == b'"' {
        out.push(b'"');
      }
      out.push(c);
    }
    out.push(b'"');
  } else {
    out.extend_from_slice(value);
  }
}

/// Order-sensitive hash of a composite key. Length-prefixing keeps
/// `("ab","c")` and `("a","bc")` apart.
pub struct KeyHasher(Xxh3);

impl KeyHasher {
  pub fn new() -> Self {
    Self(Xxh3::new())
  }

  pub fn part(&mut self, raw: &[u8]) {
    let v = unquote(raw);
    self.0.update(&(v.len() as u32).to_le_bytes());
    self.0.update(&v);
  }

  pub fn finish(&self) -> u128 {
    self.0.digest128()
  }
}

pub fn strip_bom(rec: &[u8]) -> &[u8] {
  rec.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(rec)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn record_end_respects_quotes() {
    assert_eq!(find_record_end(b"a,b\nc"), Some(4));
    assert_eq!(find_record_end(b"\"a\nb\",c\nd"), Some(8));
    assert_eq!(find_record_end(b"\"a\"\"\nb\"\nx"), Some(8));
    assert_eq!(find_record_end(b"a,b"), None);
  }

  #[test]
  fn split_keeps_raw_fields() {
    let rec = b"a,\"b,c\",,\"d\"\"e\"";
    let mut out = Vec::new();
    split_fields(rec, usize::MAX, &mut out);
    let got: Vec<&[u8]> = out.iter().map(|&r| field(rec, r)).collect();
    assert_eq!(got, vec![&b"a"[..], b"\"b,c\"", b"", b"\"d\"\"e\""]);
    split_fields(rec, 2, &mut out);
    assert_eq!(out.len(), 2);
    assert_eq!(&*unquote(b"\"d\"\"e\""), b"d\"e");
  }

  #[test]
  fn reader_handles_records_larger_than_buffer() {
    let data = b"aaaaaaaaaa,bbbbbbbbbb\r\n\"x\ny\",z\nlast";
    let mut r = RecordReader::new(&data[..], 4);
    let mut got = Vec::new();
    while let Some((off, rec)) = r.next_record().unwrap() {
      got.push((off, rec.to_vec()));
    }
    assert_eq!(got[0], (0, b"aaaaaaaaaa,bbbbbbbbbb".to_vec()));
    assert_eq!(got[1], (23, b"\"x\ny\",z".to_vec()));
    assert_eq!(got[2], (31, b"last".to_vec()));
  }
}
