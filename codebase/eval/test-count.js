const http = require("http");
const QDRANT_URL = "http://localhost:6333";
const COLLECTION = "vlearn_tutor";

http.get(`${QDRANT_URL}/collections/${COLLECTION}`, (res) => {
  let buf = "";
  res.on("data", (c) => (buf += c));
  res.on("end", () => {
    console.log("Status:", res.statusCode);
    const j = JSON.parse(buf);
    console.log("Result:", JSON.stringify(j.result, null, 2));
  });
}).on("error", (e) => console.error(e));
