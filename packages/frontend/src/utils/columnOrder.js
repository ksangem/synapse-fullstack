/* Moving table columns to the front, and putting them back.

   TableFrame pins a column by moving its cells to the left end of every row. It does not
   own the markup — the caller renders the <table> — so this works on the live DOM, and the
   whole scheme rests on one idea: a cell's identity is its NATURAL index (the caller's own
   column order), stamped on the cell as `data-tf-idx`, never its current position.

   Kept out of the component file so the ordering algebra can be exercised directly; a
   component module that also exports plain functions loses fast refresh. */

/* Rows we may reorder. A colspan cell (an expanded detail row, an empty state) spans the
   whole table, so it has no column N to move and must be left exactly as it is. */
export const isGridRow = (row, colCount) => (
  row.children.length === colCount
  && !Array.prototype.some.call(row.children, (c) => c.colSpan > 1)
);

/** Put every row back in the caller's own column order.
 *
 *  Only rows whose leading cells we actually moved are touched — `data-tf-moved` is the
 *  proof. If React rebuilt a row since the last pass its cells arrive in natural order
 *  WITHOUT that marker, and "undoing" is precisely what would corrupt them. */
export function restoreOrder(table, colCount) {
  for (const row of table.rows) {
    if (!isGridRow(row, colCount)) continue;
    const moved = [];
    for (const cell of Array.prototype.slice.call(row.children)) {
      if (cell.dataset.tfMoved) moved.push(cell); else break;
    }
    if (!moved.length) continue;
    for (const cell of moved) { delete cell.dataset.tfMoved; row.removeChild(cell); }
    /* `moved` is ascending by natural index and what remains is in natural relative
       order, so re-inserting each at its own index rebuilds the original row exactly. */
    for (const cell of moved) {
      row.insertBefore(cell, row.children[Number(cell.dataset.tfIdx)] || null);
    }
  }
}

/** Stamp each cell with its natural index. Only ever called with the DOM known to be in
 *  the caller's order — right after `restoreOrder`, or on a row React has just built. */
export function stampNaturalIndexes(table, colCount) {
  for (const row of table.rows) {
    if (!isGridRow(row, colCount)) continue;
    Array.prototype.forEach.call(row.children, (c, i) => { c.dataset.tfIdx = String(i); });
  }
}

/** Move the pinned columns to the front of every row, keeping their natural order among
 *  themselves — pinning column 5 then column 2 puts 2 first, which is the order the table
 *  already reads in and the only one that stays stable as pins come and go.
 *  @param naturalIdxs ascending natural indexes */
export function moveToFront(table, naturalIdxs, colCount) {
  for (const row of table.rows) {
    if (!isGridRow(row, colCount)) continue;
    naturalIdxs.forEach((ni, k) => {
      const cell = Array.prototype.find.call(row.children, (c) => Number(c.dataset.tfIdx) === ni);
      if (!cell) return;
      cell.dataset.tfMoved = '1';
      row.insertBefore(cell, row.children[k] || null);
    });
  }
}
