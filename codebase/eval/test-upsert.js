#!/usr/bin/env node
// test-upsert.js — Test Qdrant upsert
const http = require("http");
const QDRANT_URL = "http://localhost:6333";
const COLLECTION = "vlearn_tutor";

const body = JSON.stringify({
  points: [{
    id: 999,
    vector: new Array(10).fill(0.01),
    payload: { code: "TEST", text: "test" }
  }]
});

const u = new URL(`${QDRANT_URL}/collections/${COLLECTION}/points`);
const opts = {
  hostname: u.hostname,
  port: u.port,
  path: u.pathname,
  method: "PUT",
  headers: {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  }
};

console.log("Request:", opts);
console.log("Body:", body.slice(0, 200));

const req = http.request(opts, (res) => {
  let buf = "";
  res.on("data", (c) => (buf += c));
  res.on("end", () => {
    console.log("Status:", res.statusCode);
    console.log("Response:", buf.slice(0, 500));
  });
});
req.on("error", (e) => console.error("Error:", e));
req.write(body);
req.end();
