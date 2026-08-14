onmessage = (e) => {
  const arr = new Int32Array(e.data);
  Atomics.store(arr, 0, 42);
  Atomics.notify(arr, 0);
  postMessage('done');
};
