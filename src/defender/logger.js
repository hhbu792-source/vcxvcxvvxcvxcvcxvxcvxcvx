function formatTimestamp(date = new Date()) {
  try {
    return date.toLocaleString("sv-SE", {
      timeZone: "Europe/Istanbul",
      hour12: false,
    });
  } catch {
    return date.toISOString().replace("T", " ").slice(0, 19);
  }
}

function createLogger(scope = "DEFENDER") {
  const prefix = (level) => `[${formatTimestamp()}] [${level}] [${scope}]`;
  return {
    info(...args) {
      console.log(prefix("INFO"), ...args);
    },
    log(...args) {
      console.log(prefix("INFO"), ...args);
    },
    warn(...args) {
      console.warn(prefix("WARN"), ...args);
    },
    error(...args) {
      console.error(prefix("ERROR"), ...args);
    },
  };
}

module.exports = { createLogger, formatTimestamp };
