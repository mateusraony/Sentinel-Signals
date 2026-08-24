// Crash-safe write: temp file + rename (atomic on the same filesystem on
// POSIX) instead of writing the final path directly — a process killed
// mid-write (OOM, timeout, ctrl-C) never leaves a truncated/corrupted
// outFile behind for the next run to silently pick up.
//
// docs/known-risks.md item 125 (achado menor): this does NOT by itself
// serialize two concurrent writers of the same outFile — whichever rename
// lands last still wins, same as a plain writeFileSync would. Only relevant
// if these scripts are run twice at once by hand; not a production path
// (scripts/fetch-backtest-data.mjs / fetch-backtest-data-futures.mjs run
// once per manual/CI invocation, never concurrently with themselves).
import fs from 'node:fs';

export function writeJsonAtomic(outFile, data) {
  const tmpFile = `${outFile}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, JSON.stringify(data));
  fs.renameSync(tmpFile, outFile);
}
