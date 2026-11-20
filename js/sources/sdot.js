// Seattle Department of Transportation street trees: trees in the public right of
// way, whether the city or the adjacent property owner maintains them.
import { createArcgisSource } from './make.js';

export const SDOT_URL = 'https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/SDOT_Trees_CDL/FeatureServer/0';

export const sdotConfig = {
  id: 'sdot',
  label: 'Street trees',
  shortLabel: 'Street',
  noun: 'Street tree',
  cardLabel: 'Street tree (SDOT)',
  inventoryName: 'street tree inventory',
  publisher: 'Seattle Department of Transportation',
  credit: 'City of Seattle, Seattle Department of Transportation',
  covers: 'Trees in the public right of way (planting strips, medians, sidewalks), city- and neighbor-maintained.',
  refresh: 'Updated daily by the city',
  infoUrl: 'https://data-seattlecitygis.opendata.arcgis.com/datasets/SeattleCityGIS::sdot-trees',
  url: SDOT_URL,
  activeWhere: "CURRENT_STATUS = 'INSVC'",
  placeKind: 'address',
  numericId: false,
  fields: {
    oid: 'OBJECTID', id: 'UNITID', common: 'COMMON_NAME', scientific: 'SCIENTIFIC_NAME', diameter: 'DIAM',
    height: 'TREEHEIGHT', planted: 'PLANTED_DATE', place: 'UNITDESC', heritage: 'HERITAGE',
  },
};

export const sdot = createArcgisSource(sdotConfig);
