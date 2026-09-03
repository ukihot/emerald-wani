import * as v from 'valibot';

export const CrocodileKindSchema = v.picklist([
	'nushi',
	'katsugi',
	'pocha',
	'biyoon',
	'naname',
	'sekkachi',
	'tobi',
	'kowa'
]);

export const CellIdSchema = v.pipe(v.string(), v.regex(/^[0-6]:[0-8]$/));

export const MapSeedSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(32));

export const DeploymentPlacementSchema = v.strictObject({
	kind: CrocodileKindSchema,
	cellId: CellIdSchema
});

export const GameActionSchema = v.strictObject({
	type: v.picklist(['move', 'bite', 'jump', 'warp', 'transport', 'feed']),
	pieceId: v.pipe(
		v.string(),
		v.regex(/^[01]:(nushi|katsugi|pocha|biyoon|naname|sekkachi|tobi|kowa)$/)
	),
	toCellId: v.optional(CellIdSchema),
	targetPieceId: v.optional(
		v.pipe(v.string(), v.regex(/^[01]:(nushi|katsugi|pocha|biyoon|naname|sekkachi|tobi|kowa)$/))
	),
	remote: v.optional(v.boolean())
});

export type GameActionInput = v.InferOutput<typeof GameActionSchema>;
