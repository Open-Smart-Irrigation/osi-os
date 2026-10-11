import {test} from '@playwright/test';

// Task 5 authors these native traces now. Task 10 executes them after the public
// host and its clock controls land in Tasks 7-9.
test.describe('Public automatic irrigation traces (pending public host)', () => {
  test.skip('TR01 dry SWT at 06:00 opens through the native schedule and valve history (Tasks 7-10)', async () => {});
  test.skip('TR02 wet SWT skips; disabling the saved rule prevents the next daily evaluation (Tasks 7-10)', async () => {});
  test.skip('TR03 threshold and duration edits change the next daily evaluation (Tasks 7-10)', async () => {});
  test.skip('C22 SWT_AVG shows the row-mean result and does not count WATERMARK-linked rows (Tasks 7-10)', async () => {});
  test.skip('C27-C30 DENDRO sensitivity, response mode, freshness, and source selection appear in the advisory (Tasks 7-10)', async () => {});
  test.skip('C36 a manual or weekly valve owner makes a simultaneous automatic start skip as busy (Tasks 7-10)', async () => {});
});
