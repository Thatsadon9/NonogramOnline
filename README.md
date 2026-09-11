# Nonogram Online

เกม Nonogram แบบเล่นคนเดียวหรือสร้างห้องเพื่อเล่นออนไลน์ร่วมกับเพื่อนแบบ realtime ข้อมูลห้องและกระดานเก็บบน Neon PostgreSQL

## Features

- ตารางขนาด 5×5, 10×10, 15×15, 20×20 และ 25×25
- โจทย์ที่ผ่านการตรวจว่ามีคำตอบเดียว
- คลิกวนสถานะ ว่าง → เติม → กากบาท → ว่าง
- Multiplayer room พร้อมแชร์ลิงก์และซิงก์กระดาน
- รองรับมือถือและเดสก์ท็อป

## Local development

ต้องใช้ Node.js 22.13 ขึ้นไป

```bash
npm ci
cp .env.example .env.local
# ใส่ Neon connection string ใน DATABASE_URL
npm run dev
```

เปิด http://localhost:5173

## Commands

```bash
npm run puzzle:check
npm run lint
npm run build
```

## Database

ตั้งค่า `DATABASE_URL` เป็น Neon pooled connection string แล้วรัน SQL ใน `migrations/001_nonogram_rooms.sql` หนึ่งครั้งก่อนเปิดใช้งาน multiplayer

## Deployment

โปรเจกต์ตั้งค่าเป็น Next.js และ deploy ได้บน Vercel โดยเพิ่ม `DATABASE_URL` เป็น Production Environment Variable
