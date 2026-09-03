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

	it('全63マスに座標・地形・占有状態を含むアクセシブル名がある', async () => {
		render(GamePage);
		const board = page.getByRole('region', { name: 'ゲーム盤' });
		await expect.element(board).toBeInTheDocument();
		const cells = board.getByRole('button', { name: /列.*段、/ });
		await expect.poll(async () => (await cells.all()).length).toBe(63);
	});
});
