# Porting notes

Source references in `cloud-controller-simulator/app`:

| This project | Origin |
| --- | --- |
| `src/lib/svgImport.js` | `src/hooks/useLayerStore.js` — `parseMasterSvg`, `parseIndividualSvg` |
| `src/lib/venueSampling.js` | `src/lib/venueSampling.js` |
| `src/lib/layerSampling.js` | `src/hooks/useShowControlSimulator.js` — `createSamplingEnvironment`, `sampleLayerPoints` helpers |
| `src/lib/bandSync.js` | `src/components/ShowControlApp.jsx` — `sendToBand`, serial queue, bridge `fetch` |
