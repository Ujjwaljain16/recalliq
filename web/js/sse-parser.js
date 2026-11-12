// A small incremental parser for a Server-Sent Events stream read with fetch. It accepts chunks of any size
// (an event may be split anywhere), handles LF, CRLF and CR line endings, ignores comment lines (heartbeats),
// and joins multi-line `data:` fields with a newline, as the SSE format specifies.

/**
 * @param {(event: { id: string | null, event: string, data: string }) => void} onEvent
 * @param {(comment: string) => void} [onComment]
 */
export function createSseParser(onEvent, onComment) {
  let buffer = '';
  let id = null;
  let name = 'message';
  /** @type {string[]} */
  let data = [];
  let hasData = false;

  function dispatch() {
    if (hasData) onEvent({ id, event: name, data: data.join('\n') });
    name = 'message';
    data = [];
    hasData = false;
  }

  function line(text) {
    if (text === '') return dispatch();
    if (text.startsWith(':')) {
      if (onComment) onComment(text.slice(1).trim());
      return;
    }
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') name = value;
    else if (field === 'data') {
      data.push(value);
      hasData = true;
    } else if (field === 'id') id = value;
  }

  return {
    /** @param {string} chunk */
    feed(chunk) {
      buffer += chunk;
      let start = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const ch = buffer[i];
        if (ch !== '\n' && ch !== '\r') continue;
        if (ch === '\r' && i === buffer.length - 1) break; // may be the first half of CRLF
        line(buffer.slice(start, i));
        if (ch === '\r' && buffer[i + 1] === '\n') i += 1;
        start = i + 1;
      }
      buffer = buffer.slice(start);
    },
    /** The stream ended: an unfinished event is discarded, as the format requires. */
    end() {
      buffer = '';
      data = [];
      hasData = false;
    },
  };
}
