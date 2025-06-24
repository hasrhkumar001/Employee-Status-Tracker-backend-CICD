import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import projectRoutes from './routes/projects.js';
import teamRoutes from './routes/teams.js';
import statusRoutes from './routes/status.js';
import questionRoutes from './routes/questions.js';
import reportRoutes from './routes/reports.js';
import excelimportRoutes from './routes/excelImport.js'

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();

// Middleware
app.use(cors({
  origin: 'http://localhost:5173', // Vite's default port
  credentials: true
}));
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('Could not connect to MongoDB', err));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/status', statusRoutes);
app.use('/api/questions', questionRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/import', excelimportRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send({ message: 'Something went wrong!', error: err.message });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Increase the body parser limits to handle large file uploads
app.use(express.json({ 
  limit: '50mb',  // Increase JSON payload limit
  extended: true 
}));

app.use(express.urlencoded({ 
  limit: '50mb',  // Increase URL-encoded payload limit
  extended: true,
  parameterLimit: 1000000  // Increase parameter limit
}));

// Add timeout middleware for long-running uploads
app.use((req, res, next) => {
  // Set timeout to 5 minutes for file uploads
  if (req.path.includes('/upload')) {
    req.setTimeout(300000); // 5 minutes
    res.setTimeout(300000); // 5 minutes
  }
  next();
});

// Error handling middleware for multer and other upload errors
app.use((error, req, res, next) => {
  console.error('Upload error middleware:', error);
  
  if (error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      message: 'File too large. Maximum size is 10MB.'
    });
  }
  
  if (error.code === 'LIMIT_FIELD_VALUE') {
    return res.status(413).json({
      success: false,
      message: 'Field value too large.'
    });
  }
  
  if (error.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      success: false,
      message: 'Unexpected file field.'
    });
  }
  
  if (error.message === 'Only Excel files are allowed') {
    return res.status(400).json({
      success: false,
      message: 'Only Excel files (.xlsx, .xls) are allowed.'
    });
  }
  
  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      message: 'Request entity too large. Please reduce file size or data amount.'
    });
  }
  
  // Generic error response
  res.status(500).json({
    success: false,
    message: 'Server error during upload',
    error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
  });
});
