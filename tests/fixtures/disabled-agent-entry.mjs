// Safety fixture for `npm start` smoke tests with every Agent disabled.
// If a regression launches this file, fail without contacting any model.
process.stderr.write("disabled GroupX smoke Agent was unexpectedly launched\n");
process.exitCode = 64;
