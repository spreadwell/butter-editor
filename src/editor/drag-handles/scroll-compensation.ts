/** iOS needs an explicit anchor correction when moving a block upward. */
export function shouldCompensateUpwardDrop(
  isIosApp: boolean,
  targetSlotIdx: number,
  sourceSlotIdx: number,
): boolean {
  return isIosApp && targetSlotIdx < sourceSlotIdx;
}
