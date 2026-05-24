export function readinessRowCoverageErrors(expectedRows, readinessRows) {
  const errors = [];
  const expectedSet = new Set(expectedRows);
  const readinessSet = new Set(readinessRows);
  const missing = expectedRows.filter((row) => !readinessSet.has(row));
  const extra = readinessRows.filter((row) => !expectedSet.has(row));
  const expectedDuplicates = duplicateRows(expectedRows);
  const readinessDuplicates = duplicateRows(readinessRows);

  if (missing.length) {
    errors.push(`readiness requirements missing strict matrix rows: ${missing.join(", ")}`);
  }
  if (extra.length) {
    errors.push(`readiness requirements reference unknown strict matrix rows: ${extra.join(", ")}`);
  }
  if (expectedDuplicates.length) {
    errors.push(`strict matrix duplicate rows: ${expectedDuplicates.join(", ")}`);
  }
  if (readinessDuplicates.length) {
    errors.push(`readiness requirements duplicate rows: ${readinessDuplicates.join(", ")}`);
  }

  return errors;
}

function duplicateRows(rows) {
  const seen = new Set();
  const duplicates = new Set();
  for (const row of rows) {
    if (seen.has(row)) {
      duplicates.add(row);
    } else {
      seen.add(row);
    }
  }
  return [...duplicates].sort();
}
