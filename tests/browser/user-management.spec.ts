import {test,expect} from '@playwright/test';

test('admin navigates dashboard sidebar and creates login with owned room',async({page})=>{
  const rooms=[{id:'default',name:'Ruang utama',role:'owner',groupId:null}];
  const users:any[]=[{id:'admin',name:'Pemilik',email:'owner@local',admin:true,disabled:false,rooms:[]}];
  await page.route('**/api/session',route=>route.fulfill({json:{authenticated:true,user:{id:'admin',name:'Pemilik',admin:true},rooms}}));
  await page.route('**/api/rooms',async route=>route.fulfill({json:{rooms}}));
  await page.route('**/api/admin/users',async route=>route.fulfill({json:{users}}));
  await page.route('**/api/admin/users',async route=>{
    if(route.request().method()!=='POST')return route.fallback();
    const data=route.request().postDataJSON();expect(data.role).toBe('owner');expect(data.roomName).toBe('Cafe Senja');
    users.push({id:'new-owner',name:data.name,email:data.email,admin:false,disabled:false,rooms:[{roomId:'new-room',roomName:data.roomName,role:'owner'}]});
    rooms.push({id:'new-room',name:data.roomName,role:'owner',groupId:null});
    return route.fulfill({json:{id:'new-owner'},status:201});
  });
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Semua ruang'})).toBeVisible();
  await page.getByRole('button',{name:'Manajemen pengguna'}).click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button',{name:'Tambah pengguna'}).click();
  await page.getByLabel('Nama pemilik').fill('Pemilik Cafe');
  await page.getByLabel('Email login').fill('cafe@example.test');
  await page.getByLabel('Password awal').fill('secure-owner-password');
  await page.getByLabel('Nama ruang pertama').fill('Cafe Senja');
  await page.getByRole('button',{name:'Buat akun & ruang'}).click();
  await expect(page.getByRole('cell',{name:/Cafe Senja/})).toBeVisible();
  await page.getByRole('button',{name:'Ruang',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Semua ruang'})).toBeVisible();
});
