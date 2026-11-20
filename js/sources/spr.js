// Seattle Parks and Recreation's inventory of individual trees on park property.
// It has no planting date and no street address: the park name is the place.
import { createArcgisSource } from './make.js';

export const SPR_URL = 'https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/SPR_Tree_View/FeatureServer/0';

export const sprConfig = {
  id: 'spr',
  label: 'Park trees',
  shortLabel: 'Park',
  noun: 'Park tree',
  cardLabel: 'Park tree (Seattle Parks)',
  inventoryName: 'park tree inventory',
  publisher: 'Seattle Parks and Recreation',
  credit: 'Seattle Parks and Recreation, Urban Forestry',
  covers: 'Individually inventoried trees in Seattle parks and on park boulevards. Not every park tree: natural areas are mostly not inventoried tree by tree.',
  refresh: 'Updated weekly by the city',
  infoUrl: 'https://data-seattlecitygis.opendata.arcgis.com/datasets/SeattleCityGIS::spr-tree-view',
  url: SPR_URL,
  activeWhere: "STATUS = 'Existing'", // leaves out snags (dead, standing) and records with no status
  placeKind: 'park',
  numericId: true,
  fields: {
    oid: 'OBJECTID', id: 'TREE_ID', common: 'COMMON', scientific: 'SPECIES', diameter: 'DBH_WL',
    height: 'HEIGHT_WL', planted: null, place: 'PARK', heritage: null,
  },
};

export const spr = createArcgisSource(sprConfig);
