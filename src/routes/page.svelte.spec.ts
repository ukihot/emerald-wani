import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import GamePage from './+page.svelte';

describe('ローカルCPU対戦', () => {
	it('布陣を公開し、CPUの応答を受け、終局画面まで操作できる', async () => {
		render(GamePage);

		await page.getByRole('button', { name: 'おすすめ配置' }).click();
		await page.getByRole('button', { name: /布陣を確定/ }).click();
		await expect.element(page.getByText('あなたのターン')).toBeInTheDocument();

		await page.getByRole('button', { name: 'ターン終了' }).click();
		await expect
			.poll(async () => page.getByText('あなたのターン').query() !== null, { timeout: 3_000 })
			.toBe(true);

		await page.getByRole('button', { name: '投了' }).click();
		await expect.element(page.getByRole('heading', { name: '敗北' })).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: '同じ条件でもう一戦' })).toBeEnabled();
	});

	it('合法手ではないマスを押しても駒が動かない', async () => {
		render(GamePage);

		await page.getByRole('button', { name: 'おすすめ配置' }).click();
		await page.getByRole('button', { name: /布陣を確定/ }).click();
		await expect.element(page.getByText('あなたのターン')).toBeInTheDocument();

		const board = page.getByRole('region', { name: 'ゲーム盤' });
		// 自陣中央のヌシワニ(4列8段)を選択してから、遠く離れた敵陣の空きマスを押す。
		await board.getByRole('button', { name: /^4列8段/ }).click();
		await board.getByRole('button', { name: /^1列1段/ }).click();

		// 以前は空きマス全部が合法手として一致し、どこを押しても先頭の行動
		// （北へ1マス移動）が実行されていた。
		await expect
			.element(board.getByRole('button', { name: /^4列8段、通常、ヌシワニ/ }))
			.toBeInTheDocument();
		expect(page.getByText('ヌシワニ：移動').query()).toBeNull();
	});

	it('合法手のマスを押すとその駒がそのマスへ動く', async () => {
		render(GamePage);

		await page.getByRole('button', { name: 'おすすめ配置' }).click();
		await page.getByRole('button', { name: /布陣を確定/ }).click();
		await expect.element(page.getByText('あなたのターン')).toBeInTheDocument();

		const board = page.getByRole('region', { name: 'ゲーム盤' });
		// 自陣の巣(4列9段)は固定ゾーンなので seed に依存せず、ヌシワニ(4列8段)の
		// 南隣として常に合法な移動先になる。
		await board.getByRole('button', { name: /^4列8段/ }).click();
		await board.getByRole('button', { name: /^4列9段/ }).click();

		await expect
			.element(board.getByRole('button', { name: /^4列9段、巣、ヌシワニ/ }))
			.toBeInTheDocument();
		await expect.element(page.getByText('ヌシワニ：移動')).toBeInTheDocument();
	});

	it('全63マスに座標・地形・占有状態を含むアクセシブル名がある', async () => {
		render(GamePage);
		const board = page.getByRole('region', { name: 'ゲーム盤' });
		await expect.element(board).toBeInTheDocument();
		const cells = board.getByRole('button', { name: /列.*段、/ });
		await expect.poll(async () => (await cells.all()).length).toBe(63);
	});
});
