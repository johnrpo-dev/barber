import { expect, test } from "@playwright/test";

test("la portada carga", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Villa" })).toBeVisible();
});
