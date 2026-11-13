// One HTTP byte range, including open-ended and suffix forms. Multi-range is
// deliberately ignored (a full 200 is allowed by HTTP); invalid bounds yield 416.
export async function rangeResponse(response, header) {
    if (!header || !header.startsWith('bytes=') || header.includes(',')) return response;
    const body = await response.arrayBuffer(), size = body.byteLength;
    const headers = new Headers(response.headers);
    headers.set('Accept-Ranges', 'bytes');
    headers.delete('Content-Encoding');
    const match = /^bytes=(\d*)-(\d*)$/.exec(header);
    let start, end;
    if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
        end = match[1] ? (match[2] ? Math.min(Number(match[2]),size-1) : size-1) : size-1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size || size === 0) {
        headers.set('Content-Range', `bytes */${size}`);
        headers.set('Content-Length', '0');
        return new Response(null,{status:416,headers});
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', String(end-start+1));
    return new Response(body.slice(start,end+1),{status:206,headers});
}
