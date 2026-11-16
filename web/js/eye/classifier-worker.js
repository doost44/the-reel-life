// Runs CLIP's image model for classifier.js, on a thread of its own: ONNX
// Runtime Web (web/vendor/onnxruntime-web), one CPU thread (GitHub Pages
// can't give pages the isolation that more threads need). A classic worker,
// as ONNX Runtime's script loads with importScripts.
//
// From the eye: load { id, model, runtime }, classify { id, pixels (3×224×224 Float32Array) }.
// To the eye: { id, error } or { id } (loaded) or { id, embedding, seconds }.

let session = null;

self.onmessage = async ({ data }) => {
  try {
    if (data.kind === 'load') {
      importScripts(`${data.runtime}ort.wasm.min.js`);
      self.ort.env.wasm.wasmPaths = data.runtime;
      self.ort.env.wasm.numThreads = 1;
      self.ort.env.logLevel = 'error';
      const response = await fetch(data.model);
      if (!response.ok) throw new Error(`the model: ${response.status}`);
      session = await self.ort.InferenceSession.create(new Uint8Array(await response.arrayBuffer()), { executionProviders: ['wasm'] });
      self.postMessage({ id: data.id });
    } else if (data.kind === 'classify') {
      const started = performance.now();
      const input = new self.ort.Tensor('float32', data.pixels, [1, 3, 224, 224]);
      const output = await session.run({ pixel_values: input });
      const embedding = Array.from(output.image_embeds.data);
      self.postMessage({ id: data.id, embedding, seconds: (performance.now() - started) / 1000 });
    }
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error?.message ?? error) });
  }
};
