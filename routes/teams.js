import express from 'express';
import { check, validationResult } from 'express-validator';
import mongoose from 'mongoose'; // Add this import
import Team from '../models/Team.js';
import User from '../models/User.js';
import Project from '../models/Project.js';
import { auth, isAdmin, isManager, isProjectManager } from '../middleware/auth.js';

const router = express.Router();

// @route   POST /api/teams
// @desc    Create a team
// @access  Private (Admin, Project Manager)
router.post('/', [
  auth,
  isAdmin,
  [
    check('name', 'Name is required').not().isEmpty(),
    check('project', 'Project is required').not().isEmpty()
  ]
], async (req, res) => {
  
  
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    let { name, description, project, members = [], questions = [], active } = req.body;

    if (!mongoose.Types.ObjectId.isValid(project)) {
      return res.status(400).json({ message: 'Invalid project ID' });
    }

    for (let id of members) {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: `Invalid member ID: ${id}` });
      }
    }

    for (let id of questions) {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: `Invalid question ID: ${id}` });
      }
    }

    project = new mongoose.Types.ObjectId(project);
    members = members.map(id => new mongoose.Types.ObjectId(id));
    questions = questions.map(id => new mongoose.Types.ObjectId(id));

    // Check if user has access to project
    if (req.user.role !== 'admin') {
      const isManager = req.user.projects.includes(project.toString());
      if (!isManager) {
        return res.status(403).json({ message: 'Not authorized to create teams for this project' });
      }
    }

    const team = new Team({
      name,
      description,
      project,
      members,
      questions,
      createdBy: req.user._id,
      active: active ?? true
    });

    await team.save();

    await Project.findByIdAndUpdate(
      project,
      { $addToSet: { teams: team._id } }
    );

    if (members.length > 0) {
      await User.updateMany(
        { _id: { $in: members } },
        { $addToSet: { teams: team._id, projects: project } }
      );
    }

    res.status(201).json(team);
  } catch (err) {
    console.error('🔥 Full Error:', err);
    // Fixed: Return JSON response instead of plain text
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});


// GET /api/teams/members/:teamId
router.get('/members/:teamId', auth, async (req, res) => {
  try {
    const { teamId } = req.params;

    // Find the team and populate members
    const team = await Team.findById(teamId).populate('members', 'name email');

    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    res.json(team.members);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/teams
// @desc    Get all teams (filtered by access level)
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    let query = {};
    
    // Filter by project if provided
    if (req.query.project) {
      query.project = req.query.project;
    }
    
    // Filter by access level
    if (req.user.role === 'manager') {
      // Get all projects the manager has access to
      if (!query.project) {
        query.project = { $in: req.user.projects };
      }
    } else if (req.user.role === 'employee') {
      query.members = req.user._id;
    }
    
    const teams = await Team.find(query)
      .populate('project', 'name')
      .populate('members', 'name email')
      .populate('questions', 'text isCommon')
      .populate('createdBy', 'name');
    
    res.json(teams);
  } catch (err) {
    console.error(err.message);
    // Fixed: Return JSON response instead of plain text
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// @route   GET /api/teams/:id
// @desc    Get team by ID
// @access  Private (Admin, Project Manager, Team Member)
router.get('/:id', auth, async (req, res) => {
  try {
    const team = await Team.findById(req.params.id)
      .populate('project', 'name managers')
      .populate('members', 'name email')
      .populate('questions', 'text isCommon')
      .populate('createdBy', 'name');
    
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }
    
    // Check access permissions for non-admins
    if (req.user.role !== 'admin') {
      // Check if user is a manager of this project
      const projectManagers = team.project.managers || [];
      const isManager = projectManagers.some(
        manager => manager.toString() === req.user._id.toString()
      );
      
      // Check if user is a member of this team
      const isTeamMember = team.members.some(
        member => member._id.toString() === req.user._id.toString()
      );
      
      if (!isManager && !isTeamMember) {
        return res.status(403).json({ message: 'Not authorized to view this team' });
      }
    }
    
    res.json(team);
  } catch (err) {
    console.error(err.message);
    // Fixed: Return JSON response instead of plain text
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// @route   PUT /api/teams/:id
// @desc    Update team
// @access  Private (Admin, Project Manager)
router.put('/:id', [
  auth,
  isManager,
  [
    check('name', 'Name is required').not().isEmpty()
  ]
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const team = await Team.findById(req.params.id).populate('project');
    
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }
    
    // Check access permissions for managers
    if (req.user.role === 'manager') {
      const projectManagers = team.project.managers || [];
      const isManager = projectManagers.some(
        manager => manager.toString() === req.user._id.toString()
      );
      
      if (!isManager) {
        return res.status(403).json({ message: 'Not authorized to update this team' });
      }
    }
    
    // Update team fields
    const { name, description, members, questions, active } = req.body;
    
    if (name) team.name = name;
    if (description !== undefined) team.description = description;
    if (active !== undefined) team.active = active;
    
    // Update members if changed
    if (members) {
      // Remove team from previous members who are no longer assigned
      const removedMembers = team.members.filter(
        m => !members.includes(m.toString())
      );
      
      if (removedMembers.length > 0) {
        await User.updateMany(
          { _id: { $in: removedMembers } },
          { $pull: { teams: team._id } }
        );
      }
      
      // Add team to new members
      const newMembers = members.filter(
        m => !team.members.map(tm => tm.toString()).includes(m)
      );
      
      if (newMembers.length > 0) {
        await User.updateMany(
          { _id: { $in: newMembers } },
          { $addToSet: { teams: team._id,
             projects: team.project._id
           } }
        );
      }
      
      team.members = members;
    }
    
    // Update questions if changed
    if (questions) {
      team.questions = questions;
    }
    
    team.updatedAt = Date.now();
    
    await team.save();
    
    res.json(team);
  } catch (err) {
    console.error(err.message);
    // Fixed: Return JSON response instead of plain text
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// @route   DELETE /api/teams/:id
// @desc    Delete team
// @access  Private (Admin, Project Manager)
router.delete('/:id', [auth, isManager], async (req, res) => {
  try {
    const team = await Team.findById(req.params.id).populate('project');
    
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }
    
    // Check access permissions for managers
    if (req.user.role === 'manager') {
      const projectManagers = (team.project && team.project.managers) || [];
      const isManager = projectManagers.some(
        manager => manager.toString() === req.user._id.toString()
      );
      
      if (!isManager) {
        return res.status(403).json({ message: 'Not authorized to delete this team' });
      }
    }
    
    // Remove team from all users
    await User.updateMany(
      { teams: team._id },
      { $pull: { teams: team._id } }
    );
    
    // Remove team from project if team has a project
    if (team.project && team.project._id) {
      await Project.findByIdAndUpdate(
        team.project._id,
        { $pull: { teams: team._id } }
      );
    }
    
    await team.deleteOne();
    
    res.json({ message: 'Team removed' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// @route   GET /api/teams/:teamId/members
// @desc    Get team members with detailed information
// @access  Private (Team members, Project managers, Admin)
router.get('/:teamId/members', auth, async (req, res) => {
  try {
    const { teamId } = req.params;

    // Find the team and populate members with detailed info
    const team = await Team.findById(teamId)
      .populate({
        path: 'members',
        select: 'name email role teams createdAt lastActive',
        populate: {
          path: 'teams',
          select: 'name'
        }
      })
      .populate('project', 'name managers');

    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Check access permissions for non-admins
    if (req.user.role !== 'admin') {
      // Check if user is a manager of this project
      const projectManagers = team.project.managers || [];
      const isManager = projectManagers.some(
        manager => manager.toString() === req.user._id.toString()
      );
      
      // Check if user is a member of this team
      const isTeamMember = team.members.some(
        member => member._id.toString() === req.user._id.toString()
      );
      
      if (!isManager && !isTeamMember) {
        return res.status(403).json({ message: 'Not authorized to view team members' });
      }
    }

    // Get status count for each member (you'll need to import Status model)
    // const Status = require('../models/Status'); // Add this import at the top
    
    const membersWithDetails = await Promise.all(
      team.members.map(async (member) => {
        // Get status count for this member in this team
        // const statusCount = await Status.countDocuments({
        //   user: member._id,
        //   team: teamId
        // });

        return {
          _id: member._id,
          name: member.name,
          email: member.email,
          role: member.role || 'Member', // Default role if not set
          joinedAt: member.createdAt,
          lastActive: member.lastActive || null,
          statusCount: 0, // statusCount, // Uncomment when Status model is available
          isActive: member.lastActive && 
                   new Date(member.lastActive) > new Date(Date.now() - 24 * 60 * 60 * 1000) // Active if last seen within 24 hours
        };
      })
    );

    res.json(membersWithDetails);
  } catch (err) {
    console.error('Error fetching team members:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// @route   POST /api/teams/:teamId/members
// @desc    Add member to team
// @access  Private (Project managers, Admin)
router.post('/:teamId/members', [
  auth,
  isManager,
  [
    check('userId', 'User ID is required').not().isEmpty(),
    check('role', 'Role is required').optional()
  ]
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { teamId } = req.params;
    const { userId, role = 'Member' } = req.body;

    // Validate ObjectIds
    if (!mongoose.Types.ObjectId.isValid(teamId) || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Invalid team or user ID' });
    }

    // Find the team
    const team = await Team.findById(teamId).populate('project', 'managers');
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Check access permissions for managers
    if (req.user.role === 'manager') {
      const projectManagers = team.project.managers || [];
      const isManager = projectManagers.some(
        manager => manager.toString() === req.user._id.toString()
      );
      
      if (!isManager) {
        return res.status(403).json({ message: 'Not authorized to add members to this team' });
      }
    }

    // Check if user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if user is already a member
    if (team.members.includes(userId)) {
      return res.status(400).json({ message: 'User is already a member of this team' });
    }

    // Add user to team
    team.members.push(userId);
    await team.save();

    // Add team to user's teams array
    user.teams = user.teams || [];
    if (!user.teams.includes(teamId)) {
      user.teams.push(teamId);
      await user.save();
    }

    res.status(201).json({ message: 'Member added successfully', userId, role });
  } catch (err) {
    console.error('Error adding team member:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// @route   PUT /api/teams/:teamId/members/:memberId
// @desc    Update team member role
// @access  Private (Project managers, Admin)
router.put('/:teamId/members/:memberId', [
  auth,
  isManager,
  [
    check('role', 'Role is required').not().isEmpty()
  ]
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { teamId, memberId } = req.params;
    const { role } = req.body;

    // Validate ObjectIds
    if (!mongoose.Types.ObjectId.isValid(teamId) || !mongoose.Types.ObjectId.isValid(memberId)) {
      return res.status(400).json({ message: 'Invalid team or member ID' });
    }

    // Find the team
    const team = await Team.findById(teamId).populate('project', 'managers');
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Check access permissions for managers
    if (req.user.role === 'manager') {
      const projectManagers = team.project.managers || [];
      const isManager = projectManagers.some(
        manager => manager.toString() === req.user._id.toString()
      );
      
      if (!isManager) {
        return res.status(403).json({ message: 'Not authorized to update team members' });
      }
    }

    // Check if user is a member of the team
    if (!team.members.includes(memberId)) {
      return res.status(404).json({ message: 'User is not a member of this team' });
    }

    // Update user role (assuming you have a role field on User model or separate TeamMember model)
    const user = await User.findById(memberId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Note: This assumes you have a role field on the User model
    // If you have a separate TeamMember junction table, update that instead
    user.role = role;
    await user.save();

    res.json({ message: 'Member role updated successfully', userId: memberId, role });
  } catch (err) {
    console.error('Error updating team member:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// @route   DELETE /api/teams/:teamId/members/:memberId
// @desc    Remove member from team
// @access  Private (Project managers, Admin)
router.delete('/:teamId/members/:memberId', [auth, isManager], async (req, res) => {
  try {
    const { teamId, memberId } = req.params;

    // Validate ObjectIds
    if (!mongoose.Types.ObjectId.isValid(teamId) || !mongoose.Types.ObjectId.isValid(memberId)) {
      return res.status(400).json({ message: 'Invalid team or member ID' });
    }

    // Find the team
    const team = await Team.findById(teamId).populate('project', 'managers');
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Check access permissions for managers
    if (req.user.role === 'manager') {
      const projectManagers = team.project.managers || [];
      const isManager = projectManagers.some(
        manager => manager.toString() === req.user._id.toString()
      );
      
      if (!isManager) {
        return res.status(403).json({ message: 'Not authorized to remove team members' });
      }
    }

    // Check if user is a member of the team
    if (!team.members.includes(memberId)) {
      return res.status(404).json({ message: 'User is not a member of this team' });
    }

    // Remove user from team
    team.members = team.members.filter(member => member.toString() !== memberId);
    await team.save();

    // Remove team from user's teams array
    await User.findByIdAndUpdate(
      memberId,
      { $pull: { teams: teamId } }
    );

    res.json({ message: 'Member removed successfully' });
  } catch (err) {
    console.error('Error removing team member:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

export default router;