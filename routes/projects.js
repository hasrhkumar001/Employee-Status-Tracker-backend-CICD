import express from 'express';
import { check, validationResult } from 'express-validator';
import Project from '../models/Project.js';
import User from '../models/User.js';
import { auth, isAdmin, isManager, isProjectManager } from '../middleware/auth.js';

const router = express.Router();

// @route   POST /api/projects
// @desc    Create a project
// @access  Private (Admin only)
router.post('/', [
  auth,
  isAdmin,
  [
    check('name', 'Name is required').not().isEmpty()
  ]
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { name, description, managers = [] } = req.body;

  try {
    // Create project
    const project = new Project({
      name,
      description,
      managers,
      createdBy: req.user._id
    });

    await project.save();

    // Update manager users with the project
    if (managers.length > 0) {
      await User.updateMany(
        { _id: { $in: managers } },
        { $addToSet: { projects: project._id } }
      );
    }

    res.status(201).json(project);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   GET /api/projects
// @desc    Get all projects (filtered by access level)
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    let query = {};
    
    // Filter by access level
    if (req.user.role === 'manager') {
      query._id = { $in: req.user.projects };
    } else if (req.user.role === 'employee') {
      const teams = await Team.find({ members: req.user._id });
      const projectIds = teams.map(team => team.project);
      query._id = { $in: projectIds };
    }
    
    const projects = await Project.find(query)
      .populate('managers', 'name email')
      .populate('createdBy', 'name')
      .populate('teams', 'name');
    
    res.json(projects);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   GET /api/projects/managed
// @desc    Get all projects managed by the logged-in user
// @access  Private (Manager)
router.get('/managed', auth, async (req, res) => {
  try {
    const userId = req.user._id;

    // Find projects where this user is a manager
    const managedProjects = await Project.find({ managers: userId })
      .populate('teams') // optional: include teams
      .lean();

    res.json(managedProjects);
  } catch (error) {
    console.error('Error fetching managed projects:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/projects/:id
// @desc    Get project by ID
// @access  Private (Admin, Project Manager, Team Member)
router.get('/:id', auth, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id)
      .populate('managers', 'name email')
      .populate('teams', 'name')
      .populate('createdBy', 'name');
    
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }
    
    // Check access permissions for non-admins
    if (req.user.role !== 'admin') {
      // Check if user is a manager of this project
      const isManager = project.managers.some(
        manager => manager._id.toString() === req.user._id.toString()
      );
      
      // Check if user is a member of a team in this project
      const isTeamMember = await Team.exists({
        project: project._id,
        members: req.user._id
      });
      
      if (!isManager && !isTeamMember) {
        return res.status(403).json({ message: 'Not authorized to view this project' });
      }
    }
    
    res.json(project);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   PUT /api/projects/:id
// @desc    Update project
// @access  Private (Admin only)
router.put('/:id', [
  auth,
  isAdmin,
  [
    check('name', 'Name is required').not().isEmpty()
  ]
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const project = await Project.findById(req.params.id);
    
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }
    
    // Update project fields
    const { name, description, managers, active } = req.body;
    
    if (name) project.name = name;
    if (description !== undefined) project.description = description;
    if (active !== undefined) project.active = active;
    
    // Update managers if changed
    if (managers) {
      // Remove project from previous managers who are no longer assigned
      const removedManagers = project.managers.filter(
        m => !managers.includes(m.toString())
      );
      
      if (removedManagers.length > 0) {
        await User.updateMany(
          { _id: { $in: removedManagers } },
          { $pull: { projects: project._id } }
        );
      }
      
      // Add project to new managers
      const newManagers = managers.filter(
        m => !project.managers.map(pm => pm.toString()).includes(m)
      );
      
      if (newManagers.length > 0) {
        await User.updateMany(
          { _id: { $in: newManagers } },
          { $addToSet: { projects: project._id } }
        );
      }
      
      project.managers = managers;
    }
    
    project.updatedAt = Date.now();
    
    await project.save();
    
    res.json(project);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   DELETE /api/projects/:id
// @desc    Delete project
// @access  Private (Admin only)
router.delete('/:id', [auth, isAdmin], async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }
    
    // Remove project from all users
    await User.updateMany(
      { projects: project._id },
      { $pull: { projects: project._id } }
    );
    
    await project.deleteOne();
    
    res.json({ message: 'Project removed' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

export default router;