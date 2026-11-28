import {test,expect} from '@playwright/test';

test('hapus ruang meminta konfirmasi; batal tidak menghapus, konfirmasi memperbarui grid',async({page})=>{
 const rooms=[{id:'default',name:'Ruang utama',role:'owner',groupId:null,ownerName:'Pemilik',spotifyConnected:false,playerConnected:false,isPlaying:false,currentTrack:null,queuedCount:0},
  {id:'second',name:'Studio dua',role:'owner',groupId:null,ownerName:'Pemilik',spotifyConnected:false,playerConnected:false,isPlaying:false,currentTrack:null,queuedCount:0}];
 let deletes=0;
 await page.route('**/api/session',route=>route.fulfill({json:{authenticated:true,user:{id:'owner',name:'Pemilik',email:'owner@local',admin:true},rooms}}));
 await page.route('**/api/rooms',route=>route.fulfill({json:{rooms}}));
 await page.route('**/api/rooms/second',route=>{
  deletes++;
  expect(route.request().method()).toBe('DELETE');
  rooms.splice(1,1);
  return route.fulfill({json:{ok:true}});
 });
 await page.goto('/');
 await expect(page.getByRole('heading',{name:'Semua ruang'})).toBeVisible();
 await expect(page.locator('.room-card')).toHaveCount(2);
 await page.getByRole('button',{name:'Hapus ruang Studio dua'}).click();
 await expect(page.getByRole('dialog',{name:/Hapus ruang.*Studio dua/})).toBeVisible();
 await page.getByRole('dialog').getByRole('button',{name:'Batal'}).click();
 expect(deletes).toBe(0);
 await expect(page.locator('.room-card')).toHaveCount(2);
 await page.getByRole('button',{name:'Hapus ruang Studio dua'}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Hapus ruang'}).click();
 await expect.poll(()=>deletes).toBe(1);
 await expect(page.locator('.room-card')).toHaveCount(1);
 await expect(page.getByRole('heading',{name:'Studio dua'})).toHaveCount(0);
});
