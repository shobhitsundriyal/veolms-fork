export const RESPONSIVE_IMAGE_WIDTHS = [160, 240, 320, 480, 640, 960, 1280] as const;

export function selectResponsiveWidths(sourceWidth: number): number[] {
  return RESPONSIVE_IMAGE_WIDTHS.filter((width) => width <= sourceWidth);
}
