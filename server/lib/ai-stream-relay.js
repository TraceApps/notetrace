// Respond immediately and keep the browser-facing connection active even
// while the inference server is loading or reasoning. Only final validated
// results are used by the client to execute tools or replace note content.
export async function streamAI(res, run) {
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  const write = (event, data) => {
    if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  res.on('close', abort);
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(': connected\n\n');
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n');
  }, 15_000);
  try {
    const result = await run({ signal: controller.signal, onText: text => write('trace-text', { text }) });
    write('trace-result', result);
  } catch (error) {
    if (!controller.signal.aborted) write('trace-result', {
      ok: false, status: 502,
      data: { error: { message: error.message || 'The AI stream failed.', code: error.code } },
    });
  } finally {
    clearInterval(heartbeat);
    controller.abort();
    res.off('close', abort);
    res.end();
  }
}
