import express from 'express';
import StatusUpdate from '../models/StatusUpdate.js';
import Team from '../models/Team.js';
import Project from '../models/Project.js';
import User from '../models/User.js';
import { auth, isManager } from '../middleware/auth.js';

const router = express.Router();

// @route   GET /api/status-updates
// Get status updates (filtered by team, user, date)
router.get('/', auth, async (req, res) => {
  try {
    const { team, user, date, startDate, endDate } = req.query;
    
    // Build query based on filters
    const query = {};
    
    if (team) {
      query.team = team;
    }
    
    if (user) {
      query.user = user;
    }
    
    if (date) {
      // Filter by specific date
      const targetDate = new Date(date);
      const nextDay = new Date(targetDate);
      nextDay.setDate(nextDay.getDate() + 1);
      
      query.date = {
        $gte: targetDate,
        $lt: nextDay
      };
    } else if (startDate && endDate) {
      // Filter by date range
      query.date = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    // Apply permissions
    if (req.user.role === 'admin') {
      // Admin can see all status updates
    } else if (req.user.role === 'manager') {
      // Manager can see updates for projects they manage
      const managedProjects = await Project.find({ managers: req.user._id });
      const projectIds = managedProjects.map(project => project._id);
      
      const teams = await Team.find({ project: { $in: projectIds } });
      const teamIds = teams.map(team => team._id);
      
      query.team = query.team ? 
        (teamIds.includes(query.team) ? query.team : null) : 
        { $in: teamIds };
      
      if (query.team === null) {
        return res.json([]); // No access to the requested team
      }
    } else {
      // Employee can see updates for their teams only
      const userTeams = await Team.find({ members: req.user._id });
      const teamIds = userTeams.map(team => team._id);
      
      query.team = query.team ? 
        (teamIds.includes(query.team) ? query.team : null) : 
        { $in: teamIds };
      
      if (query.team === null) {
        return res.json([]); // No access to the requested team
      }
    }
    
    // Fetch status updates
    const statusUpdates = await StatusUpdate.find(query)
      .populate('user', 'name email')
      .populate('team', 'name')
      .populate({
        path: 'responses.question',
        select: 'text isCommon'
      })
      .sort({ date: -1 });
    
    res.json(statusUpdates);
  } catch (error) {
    console.error('Get status updates error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create status update
router.post('/', auth, async (req, res) => {
  try {
    const { team, date, responses } = req.body;
    
    if (!team || !responses || !Array.isArray(responses)) {
      return res.status(400).json({ 
        message: 'Team and responses are required' 
      });
    }
    
    // Verify team exists
    const teamDoc = await Team.findById(team);
    if (!teamDoc) {
      return res.status(404).json({ message: 'Team not found' });
    }
    
    // Check if user is in team or is a manager with access
    const isTeamMember = teamDoc.members.some(
      member => member.toString() === req.user._id.toString()
    );
    
    let isManager = false;
    if (req.user.role === 'manager' || req.user.role === 'admin') {
      const project = await Project.findById(teamDoc.project);
      isManager = project.managers.some(
        manager => manager.toString() === req.user._id.toString()
      );
    }
    
    // For employees, they can only create/update their own status
    const updateUser = req.body.user || req.user._id;
    
    if (!isTeamMember && !isManager && req.user.role !== 'admin') {
      return res.status(403).json({
        message: 'You do not have permission to create status updates for this team'
      });
    }
    
    // Employees can only update their own status
    if (req.user.role === 'employee' && 
        updateUser.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        message: 'Employees can only update their own status'
      });
    }
    
    // Format date to remove time component for consistency
    const updateDate = date ? new Date(date) : new Date();
    updateDate.setHours(0, 0, 0, 0);
    
    // Check if update already exists for this user/team/date
    const existingUpdate = await StatusUpdate.findOne({
      user: updateUser,
      team,
      date: {
        $gte: updateDate,
        $lt: new Date(updateDate.getTime() + 24 * 60 * 60 * 1000)
      }
    });
    
    if (existingUpdate) {
      // Update existing status
      existingUpdate.responses = responses;
      existingUpdate.updatedBy = req.user._id;
      
      await existingUpdate.save();
      
      const updatedStatus = await StatusUpdate.findById(existingUpdate._id)
        .populate('user', 'name email')
        .populate('team', 'name')
        .populate({
          path: 'responses.question',
          select: 'text isCommon'
        });
      
      return res.json(updatedStatus);
    }
    
    // Create new status update
    const newStatusUpdate = new StatusUpdate({
      user: updateUser,
      team,
      date: updateDate,
      responses,
      updatedBy: req.user._id
    });
    
    await newStatusUpdate.save();
    
    const populatedStatus = await StatusUpdate.findById(newStatusUpdate._id)
      .populate('user', 'name email')
      .populate('team', 'name')
      .populate({
        path: 'responses.question',
        select: 'text isCommon'
      });
    
    res.status(201).json(populatedStatus);
  } catch (error) {
    console.error('Create status update error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get status update by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const statusUpdate = await StatusUpdate.findById(req.params.id)
      .populate('user', 'name email')
      .populate('team', 'name')
      .populate({
        path: 'responses.question',
        select: 'text isCommon'
      });
    
    if (!statusUpdate) {
      return res.status(404).json({ message: 'Status update not found' });
    }
    
    // Check if user has permission to view this status update
    if (req.user.role === 'admin') {
      // Admin can view all status updates
      return res.json(statusUpdate);
    } else if (req.user.role === 'manager') {
      // Manager can view updates for projects they manage
      const team = await Team.findById(statusUpdate.team);
      const project = await Project.findById(team.project);
      
      const isManager = project.managers.some(
        manager => manager.toString() === req.user._id.toString()
      );
      
      if (isManager) {
        return res.json(statusUpdate);
      }
    } else {
      // Employee can view updates for their teams
      const team = await Team.findOne({
        _id: statusUpdate.team,
        members: req.user._id
      });
      
      if (team) {
        return res.json(statusUpdate);
      }
    }
    
    return res.status(403).json({
      message: 'You do not have permission to view this status update'
    });
  } catch (error) {
    console.error('Get status update error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update status update
router.put('/:id', auth, async (req, res) => {
  try {
    const { responses } = req.body;
    
    if (!responses || !Array.isArray(responses)) {
      return res.status(400).json({ message: 'Responses are required' });
    }
    
    const statusUpdate = await StatusUpdate.findById(req.params.id);
    if (!statusUpdate) {
      return res.status(404).json({ message: 'Status update not found' });
    }
    
    // Check if user has permission to update this status update
    if (req.user.role === 'admin') {
      // Admin can update all status updates
    } else if (req.user.role === 'manager') {
      // Manager can update status updates for projects they manage
      const team = await Team.findById(statusUpdate.team);
      const project = await Project.findById(team.project);
      
      const isManager = project.managers.some(
        manager => manager.toString() === req.user._id.toString()
      );
      
      if (!isManager) {
        return res.status(403).json({
          message: 'You do not have permission to update this status update'
        });
      }
    } else {
      // Employee can only update their own status updates
      if (statusUpdate.user.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          message: 'You can only update your own status updates'
        });
      }
    }
    
    // Update fields
    statusUpdate.responses = responses;
    statusUpdate.updatedBy = req.user._id;
    
    await statusUpdate.save();
    
    const updatedStatus = await StatusUpdate.findById(statusUpdate._id)
      .populate('user', 'name email')
      .populate('team', 'name')
      .populate({
        path: 'responses.question',
        select: 'text isCommon'
      });
    
    res.json(updatedStatus);
  } catch (error) {
    console.error('Update status update error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete status update
router.delete('/:id', auth, isManager, async (req, res) => {
  try {
    const statusUpdate = await StatusUpdate.findById(req.params.id);
    
    if (!statusUpdate) {
      return res.status(404).json({ message: 'Status update not found' });
    }
    
    // Check if user has permission to delete this status update
    if (req.user.role !== 'admin') {
      // Manager can delete status updates for projects they manage
      const team = await Team.findById(statusUpdate.team);
      const project = await Project.findById(team.project);
      
      const isManager = project.managers.some(
        manager => manager.toString() === req.user._id.toString()
      );
      
      if (!isManager) {
        return res.status(403).json({
          message: 'You do not have permission to delete this status update'
        });
      }
    }
    
    await StatusUpdate.findByIdAndDelete(req.params.id);
    
    res.json({ message: 'Status update deleted successfully' });
  } catch (error) {
    console.error('Delete status update error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

export default router;