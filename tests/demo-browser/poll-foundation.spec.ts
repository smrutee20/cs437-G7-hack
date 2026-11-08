import { expect, test } from "@playwright/test";

const portal="https://portal.feedback.test:4173";
const respond="https://respond.feedback.test:4174";

test("synthetic organiser can preview without side effects, create/open/close, and share public metadata",async({page,context})=>{
  await page.goto(portal);
  await expect(page.getByRole("button",{name:"Sign in as organiser"})).toBeVisible({timeout:5_000});
  await page.getByRole("button",{name:"Sign in as organiser"}).click();
  await expect(page.getByRole("heading",{name:"Your polls"})).toBeVisible();
  const title=`Synthetic browser poll ${Date.now()}`;
  await page.getByLabel("Poll title").fill(title);
  await page.getByLabel("Description").fill("Browser-only synthetic content");
  await page.getByLabel("Eligibility emails").fill(Array.from({length:10},(_,i)=>`demo-student${i+1}@iitgn.ac.in`).join("\n"));
  await page.getByLabel("Question 1 prompt").fill("How was the experience?");
  let writes=0;
  page.on("request",(request)=>{if(request.method()!=="GET" && request.url().includes("/api/v1/polls"))writes++;});
  await page.getByRole("button",{name:"Preview synthetic answers"}).click();
  await expect(page.getByRole("heading",{name:"Synthetic preview"})).toBeVisible();
  await expect(page.getByText("Sample rating: 3 (synthetic, not saved)")).toBeVisible();
  expect(writes).toBe(0);
  await page.getByRole("button",{name:"Save draft"}).click();
  await expect(page.getByText("Draft saved. Revision 1.")).toBeVisible();
  const listedPoll=page.getByRole("listitem").filter({hasText:title});
  const publicLink=listedPoll.getByRole("link",{name:"Public poll link"});
  const href=await publicLink.getAttribute("href");
  expect(href).toMatch(/^https:\/\/respond\.feedback\.test:4174\/p\/[0-9a-f-]+$/);
  await listedPoll.getByRole("button",{name:"Open poll"}).click();
  const openDialog=page.getByRole("dialog");
  await expect(openDialog).toContainText("Opening is irreversible");
  await openDialog.getByRole("button",{name:"Open poll"}).click();
  await expect(page.getByRole("status")).toHaveText("Poll is open.");
  await page.goto(href!);
  await expect(page.getByRole("heading",{name:title})).toBeVisible();
  await expect(page.getByText("How was the experience?")).toBeVisible();
  await expect(page.getByRole("img",{name:"Status: open"})).toBeVisible();
  expect((await context.cookies(respond)).some((cookie)=>cookie.name==="__Host-session")).toBe(false);
  await page.goto(portal);
  await expect(page.getByRole("heading",{name:"Your polls"})).toBeVisible();
  await page.getByRole("listitem").filter({hasText:title}).getByRole("button",{name:"Close poll"}).click();
  const closeDialog=page.getByRole("dialog");
  // Red, irreversible: the confirm button stays disabled until CLOSE is typed.
  await expect(closeDialog.getByRole("button",{name:"Close poll now"})).toBeDisabled();
  await closeDialog.getByLabel("Type CLOSE to confirm").fill("CLOSE");
  await closeDialog.getByRole("button",{name:"Close poll now"}).click();
  await expect(page.getByRole("status")).toHaveText("Poll is closed.");
  await page.goto(href!);
  await expect(page.getByRole("img",{name:"Status: closed"})).toBeVisible();
});
