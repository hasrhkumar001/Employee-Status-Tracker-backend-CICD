import jwt from 'jsonwebtoken';
import User from '../models/User.js';

// Middleware to authenticate user
const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);
    
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }
    
    req.user = user;
    req.token = token;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Invalid token' });
  }
};

// Middleware to check if user is admin
const isAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ message: 'Admin access required' });
  }
};

// Middleware to check if user is manager
const isManager = (req, res, next) => {
  if (req.user && (req.user.role === 'manager' || req.user.role === 'admin')) {
    next();
  } else {
    res.status(403).json({ message: 'Manager access required' });
  }
};

// Middleware to check if user is manager of specific project
const isProjectManager = async (req, res, next) => {
  try {
    const projectId = req.params.projectId || req.body.projectId;
    
    if (!projectId) {
      return res.status(400).json({ message: 'Project ID required' });
    }
    
    if (req.user.role === 'admin') {
      return next();
    }
    
    if (req.user.role === 'manager' && req.user.projects.includes(projectId)) {
      return next();
    }
    
    res.status(403).json({ message: 'Not authorized for this project' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Middleware to check if user is member of specific team
const isTeamMember = async (req, res, next) => {
  try {
    const teamId = req.params.teamId || req.body.teamId;
    
    if (!teamId) {
      return res.status(400).json({ message: 'Team ID required' });
    }
    
    if (req.user.role === 'admin') {
      return next();
    }
    
    if (req.user.teams.includes(teamId)) {
      return next();
    }
    
    res.status(403).json({ message: 'Not authorized for this team' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export { auth, isAdmin, isManager, isProjectManager, isTeamMember };