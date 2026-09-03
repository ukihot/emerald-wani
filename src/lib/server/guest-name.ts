/**
 * ゲストの表示名を自動生成する。
 *
 * ゲストにも推測困難な内部ID（better-auth 側で採番）と自動生成の表示名を割り当てる
 * （doc/designs/01-principles.md 3.2）。表示名は世界観に沿った語から組み立てる。
 * 一意性は保証しない（衝突しても実害がないため）。同名が並んだときに区別できるよう
 * 末尾に4桁の識別子を付ける。
 */

const MODIFIERS = [
	'しずかな',
	'ひなたの',
	'よあけの',
	'かわぎしの',
	'ふかい沼の',
	'みずべの',
	'なぎさの',
	'あさもやの',
	'つきよの',
	'したたる'
] as const;

const CREATURES = [
	'ワニ',
	'こワニ',
	'いりえワニ',
	'ないるワニ',
	'めがねワニ',
	'がびあるワニ',
	'ぬしワニ',
	'ひるねワニ'
] as const;

function pick<T>(items: readonly T[], random: Uint32Array, index: number): T {
	return items[random[index] % items.length];
}

export function generateGuestDisplayName(): string {
	// 表示名は秘匿情報ではないが、連番や時刻から推測できる形にはしない。
	const random = crypto.getRandomValues(new Uint32Array(3));
	const modifier = pick(MODIFIERS, random, 0);
	const creature = pick(CREATURES, random, 1);
	const suffix = (random[2] % 10000).toString().padStart(4, '0');
	return `${modifier}${creature}-${suffix}`;
}
