globalThis.fetch = async () => {
  throw new Error("Report fixture attempted a real network request");
};

await import("./run.worker.js");
