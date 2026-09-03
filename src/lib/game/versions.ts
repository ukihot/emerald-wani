export const RULE_VERSION = 'rules-1.0.0' as const;
export const MAP_VERSION = 'map-7x9-v1' as const;

export const VERSION_REGISTRY = {
	rules: {
		[RULE_VERSION]: {
			status: 'active',
			description: '8種のワニ・2活力・3P勝利の初版'
		}
	},
	maps: {
		[MAP_VERSION]: {
			status: 'active',
			description: '7×9、固定2列経路、回転対称の初版'
		}
	}
} as const;

export function isSupportedRuleVersion(
	version: string
): version is keyof typeof VERSION_REGISTRY.rules {
	return version in VERSION_REGISTRY.rules;
}

export function isSupportedMapVersion(
	version: string
): version is keyof typeof VERSION_REGISTRY.maps {
	return version in VERSION_REGISTRY.maps;
}
