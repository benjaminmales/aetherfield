"use strict";

const fs = require("fs");
const path = require("path");

const QUEUE_FILE = path.join(__dirname, "..", "telemetry-queue.json");

function loadQueue() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const raw = fs.readFileSync(QUEUE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistQueue(queue) {
  const tmp = QUEUE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(queue, null, 2) + "\n");
  fs.renameSync(tmp, QUEUE_FILE);
}

module.exports = {
  QUEUE_FILE,
  loadQueue,
  persistQueue,
};
