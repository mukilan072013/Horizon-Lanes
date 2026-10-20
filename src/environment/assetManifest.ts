export const ASSET_CATEGORIES = [
  'trees',
  'bushes',
  'rocks',
  'clouds',
  'flowers',
  'stumps',
] as const;

export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export type AssetManifest = Readonly<Record<AssetCategory, readonly string[]>>;

function numberedFiles(
  folder: string,
  stem: string,
  count: number,
  suffixes: readonly string[] = [''],
): string[] {
  return suffixes.flatMap((suffix) =>
    Array.from(
      { length: count },
      (_, index) => `/Assets/${folder}/${stem}${suffix}_${index + 1}.glb`,
    ),
  );
}

const treeFiles = [
  ...numberedFiles('Trees/Birch Trees', 'BirchTree', 5, [
    '',
    '_Autumn',
    '_Dead',
    '_Dead_Snow',
    '_Snow',
  ]),
  ...numberedFiles('Trees/Common Trees', 'CommonTree', 5, [
    '',
    '_Autumn',
    '_Dead',
    '_Dead_Snow',
    '_Snow',
  ]),
  ...numberedFiles('Trees/Palm Trees', 'PalmTree', 4),
  ...numberedFiles('Trees/Pine Trees', 'PineTree', 5, ['', '_Autumn', '_Snow']),
  ...numberedFiles('Trees/Willow Trees', 'Willow', 5, [
    '',
    '_Autumn',
    '_Dead',
    '_Dead_Snow',
    '_Snow',
  ]),
];

/**
 * Public URLs use the actual asset-pack layout and filenames in Assets/.
 * In Vite, serve this directory from public/Assets to make these paths resolve.
 */
export const environmentAssetManifest: AssetManifest = {
  trees: treeFiles,
  bushes: [
    '/Assets/Bushes/BushBerries_1.glb',
    '/Assets/Bushes/BushBerries_2.glb',
    '/Assets/Bushes/Bush_1.glb',
    '/Assets/Bushes/Bush_2.glb',
    '/Assets/Bushes/Bush_Snow_1.glb',
    '/Assets/Bushes/Bush_Snow_2.glb',
  ],
  rocks: [
    ...numberedFiles('Rocks', 'Rock', 7),
    ...numberedFiles('Rocks', 'Rock_Moss', 7),
    ...numberedFiles('Rocks', 'Rock_Snow', 7),
  ],
  clouds: numberedFiles('Clouds', 'Cloud', 17),
  flowers: [
    '/Assets/Flowers/CactusFlower_1.glb',
    ...[2, 3, 4, 5].map((number) => `/Assets/Flowers/CactusFlowers_${number}.glb`),
    '/Assets/Flowers/Flowers.glb',
    '/Assets/Flowers/Lilypad.glb',
  ],
  stumps: [
    '/Assets/Logs and Stumps/TreeStump.glb',
    '/Assets/Logs and Stumps/TreeStump_Moss.glb',
    '/Assets/Logs and Stumps/TreeStump_Snow.glb',
    '/Assets/Logs and Stumps/WoodLog.glb',
    '/Assets/Logs and Stumps/WoodLog_Moss.glb',
    '/Assets/Logs and Stumps/WoodLog_Snow.glb',
  ],
};
