/// Incremental UTF-8 decoder that never splits a multi-byte sequence across
/// two reads. Any genuinely invalid byte is dropped rather than poisoning the
/// rest of the stream (ConPTY output is not always valid UTF-8).
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn new() -> Self {
        Self {
            pending: Vec::with_capacity(8),
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut out = String::with_capacity(chunk.len());
        let mut offset = 0usize;

        loop {
            let slice = &self.pending[offset..];
            if slice.is_empty() {
                break;
            }
            match std::str::from_utf8(slice) {
                Ok(s) => {
                    out.push_str(s);
                    offset = self.pending.len();
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    if valid > 0 {
                        if let Ok(s) = std::str::from_utf8(&slice[..valid]) {
                            out.push_str(s);
                        }
                        offset += valid;
                    }
                    match e.error_len() {
                        // Incomplete tail: keep it for the next chunk.
                        None => break,
                        // Definitely invalid bytes: skip them.
                        Some(len) => offset += len,
                    }
                }
            }
        }

        if offset > 0 {
            self.pending.drain(..offset);
        }
        // Guard against a pathological stream that never completes a sequence.
        if self.pending.len() > 8 {
            self.pending.clear();
        }
        out
    }
}
