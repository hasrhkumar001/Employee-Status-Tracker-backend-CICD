import express from 'express';
import { check, validationResult } from 'express-validator';
import User from '../models/User.js';
import { auth, isAdmin, isManager } from '../middleware/auth.js';

const router = express.Router();

// @route   POST /api/users
// @desc    Create a user (admin creates managers, managers create employees)
// @access  Private (Admin, Manager)
router.post('/', [
  auth,
  isManager,
  [
    check('name', 'Name is required').not().isEmpty(),
    check('email', 'Please include a valid email').isEmail(),
    check('password', 'Please enter a password with 6 or more characters').isLength({ min: 6 }),
    check('role', 'Role is required').not().isEmpty()
  ]
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { name, email, password, role, teams = [], projects = [] } = req.body;

  try {
    // Check if user already exists
    let user = await User.findOne({ email });
    if (user) {
      return res.status(400).json({ message: 'User already exists' });
    }

    // Check role permissions
    if (req.user.role === 'manager' && role === 'admin') {
      return res.status(403).json({ message: 'Managers cannot create admin users' });
    }

    // Create user
    user = new User({
      name,
      email,
      password,
      role,
      teams,
      projects,
      createdBy: req.user._id
    });

    await user.save();

    res.status(201).json({
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      teams: user.teams,
      projects: user.projects
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   GET /api/users
// @desc    Get all users (filtered by role and access level)
// @access  Private (Admin, Manager)
router.get('/', auth, async (req, res) => {
  try {
    let query = {};
    
    // Filter by role if provided
    if (req.query.role) {
      query.role = req.query.role;
    }
    
    // Filter by access level
    if (req.user.role === 'manager') {
      // Managers can only see their created users or team members
      query.$or = [
        { createdBy: req.user._id },
        { teams: { $in: req.user.teams } }
      ];
    }
    
    const users = await User.find(query)
      .select('-password')
      .populate('teams', 'name')
      .populate('projects', 'name')
      .populate('createdBy', 'name');
    
    res.json(users);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   GET /api/users/:id
// @desc    Get user by ID
// @access  Private (Admin, Manager with access, Self)
router.get('/:id', auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password')
      .populate('teams', 'name')
      .populate('projects', 'name')
      .populate('createdBy', 'name');
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check access permissions
    const isOwnProfile = req.user._id.toString() === req.params.id;
    const isCreator = user.createdBy && req.user._id.toString() === user.createdBy.toString();
    const isTeamMember = req.user.teams.some(team => 
      user.teams.includes(team._id || team)
    );
    
    if (req.user.role !== 'admin' && !isOwnProfile && !isCreator && !isTeamMember) {
      return res.status(403).json({ message: 'Not authorized to view this user' });
    }
    
    res.json(user);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   PUT /api/users/:id
// @desc    Update user
// @access  Private (Admin, Manager with access, Self)
router.put('/:id', auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Check access permissions
    const isOwnProfile = req.user._id.toString() === req.params.id;
    const isCreator = user.createdBy && req.user._id.toString() === user.createdBy.toString();
    
    if (req.user.role !== 'admin' && !isOwnProfile && !isCreator) {
      return res.status(403).json({ message: 'Not authorized to update this user' });
    }
    
    // Prevent role escalation
    if (req.body.role && req.user.role !== 'admin' && req.body.role !== user.role) {
      return res.status(403).json({ message: 'Not authorized to change user role' });
    }
    
    // Update user fields
    const { name, email, role, teams, projects, password } = req.body;
    
    if (name) user.name = name;
    if (email) user.email = email;
    if (role && req.user.role === 'admin') user.role = role;
    if (teams && (req.user.role === 'admin' || isCreator)) user.teams = teams;
    if (projects && req.user.role === 'admin') user.projects = projects;
    if (password) user.password = password;
    
    user.updatedAt = Date.now();
    
    await user.save();
    
    res.json({
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      teams: user.teams,
      projects: user.projects
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   DELETE /api/users/:id
// @desc    Delete user
// @access  Private (Admin only)
router.delete('/:id', [auth, isAdmin], async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    await user.deleteOne();
    
    res.json({ message: 'User removed' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

router.get('/available', auth, async (req, res) => {
  try {
    const { teamId, search = '' } = req.query;

    // Build query to exclude users already in the team
    let query = {};
    
    if (teamId && mongoose.Types.ObjectId.isValid(teamId)) {
      query.teams = { $ne: teamId };
    }

    // Add search functionality
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    // Filter by access level
   

    const availableUsers = await User.find(query)
      .select('name email role')
      .limit(50) // Limit results for performance
      .sort({ name: 1 });

    res.json(availableUsers);
  } catch (err) {
    console.error('Error fetching available users:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Add this route to a new notifications.js router file or existing router

// @route   POST /api/notifications/send
// @desc    Send notification/reminder to user
// @access  Private (Project managers, Admin)
router.post('/send', [
  auth,
  isManager,
  [
    check('email', 'Email is required').isEmail(),
    check('type', 'Notification type is required').not().isEmpty(),
    check('message', 'Message is required').not().isEmpty()
  ]
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const { email, type, message } = req.body;

    // Find the user to ensure they exist
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Here you would implement your notification system
    // This could be email, in-app notifications, SMS, etc.
    
    // Example: Create a notification record (you'd need a Notification model)
    // const notification = new Notification({
    //   recipient: user._id,
    //   sender: req.user._id,
    //   type,
    //   message,
    //   sentAt: new Date()
    // });
    // await notification.save();

    // Example: Send email (you'd need to set up nodemailer or similar)
    // await sendEmail({
    //   to: email,
    //   subject: `Reminder: ${type}`,
    //   body: message
    // });

    console.log(`Notification sent to ${email}: ${message}`);
    
    res.json({ message: 'Notification sent successfully' });
  } catch (err) {
    console.error('Error sending notification:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

export default router;