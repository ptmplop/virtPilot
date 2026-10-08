// One chart vocabulary for every graph in the app. Hues come from the logo kit, and each
// clears 3:1 against the card in both themes, so a line never depends on the background.
//   - single-series charts: the metric's own colour (CPU = steel, memory = heather)
//   - paired series: inbound (read / RX) is steel, outbound (write / TX) is ochre and
//     dashed, so the pair separates by hue *and* stroke — readable in greyscale too.
export const CHART = {
  cpu: '#4F7CAC',
  memory: '#7162AA',
  inbound: '#4F7CAC',
  outbound: '#B98A4C',
  neutral: '#8592A6',
} as const;
