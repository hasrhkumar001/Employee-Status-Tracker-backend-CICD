import mongoose from 'mongoose';
import User from '../models/User.js';
import dotenv from 'dotenv';
dotenv.config();


async function createDemoAdmin() {
  await mongoose.connect(process.env.MONGODB_URI);

  const existing = await User.findOne({ email: 'admin@example.com' });
  if (existing) {
    console.log('Demo admin already exists.');
    process.exit(0);
  }

  const admin = new User({
    name: 'Demo Admin',
    email: 'admin@example.com',
    password: 'admin123', // Make sure your User model hashes passwords!
    role: 'admin',
    teams: [],
    projects: [],
    createdBy: null
  });

  await admin.save();
  console.log('Demo admin created: admin@example.com / admin123');
  process.exit(0);
}

createDemoAdmin().catch(err => {
  console.error(err);
  process.exit(1);
});