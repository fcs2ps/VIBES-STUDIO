'use strict';

/**
 * Minimal multipart/form-data parser.
 *
 * Replaces multer. We accept exactly one file plus a couple of short text
 * fields, so a streaming upload framework is more machinery than the job
 * needs — and multer 1.x carried known vulnerabilities, which is a poor
 * trade for parsing one form.
 *
 * Body is buffered with a hard size cap, so a large upload is rejected before
 * it can exhaust memory.
 */

function parseBoundary(contentType) {
  if (!contentType) return null;
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  return (m[1] || m[2]).trim();
}

/**
 * Reads the whole request body, refusing anything over maxBytes.
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let done = false;

    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      fn(arg);
    };

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const err = new Error('Payload too large');
        err.code = 'FILE_TOO_LARGE';
        req.destroy();
        return finish(reject, err);
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks)));
    req.on('error', (err) => finish(reject, err));
    req.on('aborted', () => {
      const err = new Error('Upload aborted');
      err.code = 'ABORTED';
      finish(reject, err);
    });
  });
}

/**
 * Splits a buffer on a delimiter. Buffer.indexOf handles binary safely, which
 * is why the body is never converted to a string — doing so would corrupt
 * binary STL payloads.
 */
function splitBuffer(buf, delimiter) {
  const parts = [];
  let start = 0;
  let idx;
  while ((idx = buf.indexOf(delimiter, start)) !== -1) {
    parts.push(buf.subarray(start, idx));
    start = idx + delimiter.length;
  }
  parts.push(buf.subarray(start));
  return parts;
}

/**
 * @returns {{fields: Object<string,string>, files: Array<{field, filename, contentType, data}>}}
 */
function parseMultipart(body, boundary) {
  const delimiter = Buffer.from('--' + boundary);
  const sections = splitBuffer(body, delimiter);

  const fields = {};
  const files = [];

  for (const section of sections) {
    // Skip the preamble, the trailing "--", and empty separators.
    if (section.length < 4) continue;
    const trimmed = section[0] === 0x2d && section[1] === 0x2d ? null : section;
    if (!trimmed) continue;

    const headerEnd = trimmed.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headerText = trimmed.toString('utf8', 0, headerEnd);
    // Content ends with a trailing CRLF before the next boundary.
    let content = trimmed.subarray(headerEnd + 4);
    if (content.length >= 2 &&
        content[content.length - 2] === 0x0d &&
        content[content.length - 1] === 0x0a) {
      content = content.subarray(0, content.length - 2);
    }

    const nameMatch = /name="([^"]*)"/i.exec(headerText);
    if (!nameMatch) continue;
    const field = nameMatch[1];

    const filenameMatch = /filename="([^"]*)"/i.exec(headerText);
    if (filenameMatch) {
      const ctMatch = /content-type:\s*([^\r\n]+)/i.exec(headerText);
      files.push({
        field,
        filename: filenameMatch[1],
        contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
        data: content,
      });
    } else {
      fields[field] = content.toString('utf8');
    }
  }

  return { fields, files };
}

module.exports = { parseBoundary, readBody, parseMultipart };
