import express from 'express';
import { check, validationResult } from 'express-validator';
import Question from '../models/Question.js';
import Team from '../models/Team.js';
import { auth, isAdmin, isManager } from '../middleware/auth.js';

const router = express.Router();

// @route   POST /api/questions
// @desc    Create a question
// @access  Private (Admin, Manager)
router.post('/', [
  auth,
  isManager,
  [
    check('text', 'Question text is required').not().isEmpty(),
    check('type', 'Question type must be text, single_choice, or multiple_choice')
      .isIn(['text', 'single_choice', 'multiple_choice']),
    check('options', 'Options must be an array').optional().isArray(),
    check('options.*.text', 'Option text is required').optional().not().isEmpty()
  ]
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { text, type = 'text', options = [], isCommon, teams = [], order } = req.body;

  try {
    // Validate that choice questions have options
    if ((type === 'single_choice' || type === 'multiple_choice') && options.length === 0) {
      return res.status(400).json({
        message: 'Choice questions must have at least one option'
      });
    }

    // Validate that text questions don't have options
    if (type === 'text' && options.length > 0) {
      return res.status(400).json({
        message: 'Text questions cannot have options'
      });
    }

    // Process options - ensure they have proper order
    const processedOptions = options.map((option, index) => ({
      text: option.text.trim(),
      order: option.order !== undefined ? option.order : index
    }));

    let questionTeams = teams;

    if (isCommon) {
      const allTeams = await Team.find().select('_id');
      questionTeams = allTeams.map(team => team._id);
    }
    // Create question
    const question = new Question({
      text,
      type,
      options: processedOptions,
      isCommon,
      teams,
      order: order || 0,
      createdBy: req.user._id
    });

    await question.save();

    if (questionTeams.length > 0) {
      await Team.updateMany(
        { _id: { $in: questionTeams } },
        { $addToSet: { questions: question._id } }
      );
    }

    // Add question to teams if specified
    if (teams.length > 0) {
      await Team.updateMany(
        { _id: { $in: teams } },
        { $addToSet: { questions: question._id } }
      );
    }

    res.status(201).json(question);
  } catch (err) {
    console.error(err.message);
    if (err.message.includes('Choice questions must have at least one option')) {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).send('Server error');
  }
});

// @route   GET /api/questions
// @desc    Get all questions (filtered by access and isCommon)
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    let query = {};

    // Build base filters
    const filters = {};
    
    // Filter by type if provided
    if (req.query.type) {
      filters.type = req.query.type;
    }

    // Handle team-based access control and common questions
    if (req.user.role === 'manager') {
      if (req.query.team) {
        // Specific team requested - include common questions + specific team
        query = {
          ...filters,
          $or: [
            { isCommon: true },
            { teams: req.query.team }
          ]
        };
      } else {
        // No specific team - get accessible teams + common questions
        const accessibleTeams = await Team.find({ project: { $in: req.user.projects } });
        const teamIds = accessibleTeams.map(team => team._id);

        query = {
          ...filters,
          $or: [
            { isCommon: true },
            { teams: { $in: teamIds } }
          ]
        };
      }
    } else if (req.user.role === 'employee') {
      if (req.query.team) {
        // Specific team requested - include common questions + specific team
        query = {
          ...filters,
          $or: [
            { isCommon: true },
            { teams: req.query.team }
          ]
        };
      } else {
        // No specific team - get user's teams + common questions
        query = {
          ...filters,
          $or: [
            { isCommon: true },
            { teams: { $in: req.user.teams } }
          ]
        };
      }
    } else {
      // Admin or other roles - apply filters directly
      query = filters;
      
      // Handle isCommon filter for admins
      if (req.query.isCommon) {
        query.isCommon = req.query.isCommon === 'true';
      }
      
      // Handle team filter for admins
      if (req.query.team) {
        query.teams = req.query.team;
      }
    }

    const questions = await Question.find(query)
      .sort({ order: 1 })
      .populate('teams', 'name')
      .populate('createdBy', 'name');

    res.json(questions);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   GET /api/questions/:id
// @desc    Get question by ID
// @access  Private
router.get('/:id', auth, async (req, res) => {
  try {
    const question = await Question.findById(req.params.id)
      .populate('teams', 'name project')
      .populate('createdBy', 'name');

    if (!question) {
      return res.status(404).json({ message: 'Question not found' });
    }

    // Check access for non-admins if not common
    if (req.user.role !== 'admin' && !question.isCommon) {
      // For managers - check if question is for teams in their projects
      if (req.user.role === 'manager') {
        const accessibleTeams = await Team.find({ project: { $in: req.user.projects } });
        const teamIds = accessibleTeams.map(team => team._id.toString());

        const hasAccess = question.teams.some(team =>
          teamIds.includes(team._id.toString())
        );

        if (!hasAccess) {
          return res.status(403).json({ message: 'Not authorized to view this question' });
        }
      }
      // For employees - check if question is for their teams
      else if (req.user.role === 'employee') {
        const hasAccess = question.teams.some(team =>
          req.user.teams.includes(team._id)
        );

        if (!hasAccess) {
          return res.status(403).json({ message: 'Not authorized to view this question' });
        }
      }
    }

    res.json(question);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   PUT /api/questions/:id
// @desc    Update question
// @access  Private (Admin, Creator Manager)
router.put('/:id', [
  auth,
  isManager,
  [
    check('text', 'Question text is required').not().isEmpty(),
    check('type', 'Question type must be text, single_choice, or multiple_choice')
      .optional().isIn(['text', 'single_choice', 'multiple_choice']),
    check('options', 'Options must be an array').optional().isArray(),
    check('options.*.text', 'Option text is required').optional().not().isEmpty()
  ]
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const question = await Question.findById(req.params.id);

    if (!question) {
      return res.status(404).json({ message: 'Question not found' });
    }

    // Check if user is creator or admin
    if (req.user.role !== 'admin' && question.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to update this question' });
    }

    // Update question fields
    const { text, type, options, isCommon, teams, order, active } = req.body;

    if (text) question.text = text;
    if (type !== undefined) {
      // Validate type change with options
      if ((type === 'single_choice' || type === 'multiple_choice') &&
        (!options || options.length === 0)) {
        return res.status(400).json({
          message: 'Choice questions must have at least one option'
        });
      }
      if (type === 'text' && options && options.length > 0) {
        return res.status(400).json({
          message: 'Text questions cannot have options'
        });
      }
      question.type = type;
    }

    if (options !== undefined) {
      // Process options - ensure they have proper order
      question.options = options.map((option, index) => ({
        text: option.text.trim(),
        order: option.order !== undefined ? option.order : index
      }));
    }

    if (isCommon !== undefined) question.isCommon = isCommon;
    if (order !== undefined) question.order = order;
    if (active !== undefined) question.active = active;

    // Update teams if changed
    if (teams !== undefined) {
      // Remove question from teams no longer associated
      const removedTeams = question.teams.filter(
        t => !teams.includes(t.toString())
      );

      if (removedTeams.length > 0) {
        await Team.updateMany(
          { _id: { $in: removedTeams } },
          { $pull: { questions: question._id } }
        );
      }

      // Add question to new teams
      const newTeams = teams.filter(
        t => !question.teams.map(qt => qt.toString()).includes(t)
      );

      if (newTeams.length > 0) {
        await Team.updateMany(
          { _id: { $in: newTeams } },
          { $addToSet: { questions: question._id } }
        );
      }

      question.teams = teams;
    }

    question.updatedAt = Date.now();

    await question.save();

    const updatedQuestion = await Question.findById(question._id)
      .populate('teams', 'name')
      .populate('createdBy', 'name');

    res.json(updatedQuestion);
  } catch (err) {
    console.error(err.message);
    if (err.message.includes('Choice questions must have at least one option')) {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).send('Server error');
  }
});

// @route   DELETE /api/questions/:id
// @desc    Delete question
// @access  Private (Admin, Creator Manager)
router.delete('/:id', [auth, isManager], async (req, res) => {
  try {
    const question = await Question.findById(req.params.id);

    if (!question) {
      return res.status(404).json({ message: 'Question not found' });
    }

    // Check if user is creator or admin
    if (req.user.role !== 'admin' && question.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized to delete this question' });
    }

    // Remove question from all teams
    await Team.updateMany(
      { questions: question._id },
      { $pull: { questions: question._id } }
    );

    await question.deleteOne();

    res.json({ message: 'Question removed' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   GET /api/questions/stats/types
// @desc    Get question type statistics
// @access  Private (Admin, Manager)
router.get('/stats/types', [auth, isManager], async (req, res) => {
  try {
    const stats = await Question.aggregate([
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
          active: { $sum: { $cond: ['$active', 1, 0] } },
          inactive: { $sum: { $cond: ['$active', 0, 1] } }
        }
      },
      {
        $sort: { _id: 1 }
      }
    ]);

    res.json(stats);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

export default router;