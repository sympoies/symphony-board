export function multiSelectDisabled(available: number, selectedCount: number): boolean {
  return available === 0 && selectedCount === 0;
}
