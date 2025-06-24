import express from 'express';
import { check, validationResult } from 'express-validator';
import ExcelJS from 'exceljs';
import Status from '../models/Status.js';
import Team from '../models/Team.js';
import User from '../models/User.js';
import Question from '../models/Question.js';
import { auth, isManager, isTeamMember } from '../middleware/auth.js';

const router = express.Router();

// Helper function to check date restrictions
const isDateAllowed = (dateString) => {
  const selectedDate = new Date(dateString);
  const today = new Date();
  today.setHours(23, 59, 59, 999); // End of today
  
  const twoDaysAgo = new Date(today);
  twoDaysAgo.setDate(today.getDate() - 2);
  twoDaysAgo.setHours(0, 0, 0, 0); // Start of two days ago
  
  return selectedDate >= twoDaysAgo && selectedDate <= today;
};

// @route   POST /api/status
// @desc    Create a status update or mark leave
// @access  Private (Team Member or Manager)
router.post('/', [
  auth,
  [
    check('team', 'Team is required').not().isEmpty(),
    check('user', 'User is required').not().isEmpty(),
    check('date', 'Date is required').isISO8601(),
    // Conditional validation based on isLeave
    check('isLeave').optional().isBoolean(),
    check('leaveReason').if(check('isLeave').equals('true')).not().isEmpty().withMessage('Leave reason is required when marking leave'),
    check('responses').if(check('isLeave').not().equals('true')).isArray().not().isEmpty().withMessage('Responses are required for status updates'),
    check('responses.*.question').if(check('isLeave').not().equals('true')).not().isEmpty().withMessage('Question ID is required for each response'),
    check('responses.*.answer').if(check('isLeave').not().equals('true')).not().isEmpty().withMessage('Answer is required for each response')
  ]
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { team, user, responses = [], date, isLeave = false, leaveReason } = req.body;

  try {
    // Check date restrictions
    // if (!isDateAllowed(date)) {
    //   return res.status(400).json({ 
    //     message: 'You can only add status for today or the last two days' 
    //   });
    // }

    // Check if updating own status or manager updating team member status
    const isOwnStatus = req.user._id.toString() === user;
    const teamData = await Team.findById(team).populate('project');
    
    if (!teamData) {
      return res.status(404).json({ message: 'Team not found' });
    }
    
    // Check permissions
    if (!isOwnStatus && req.user.role !== 'admin') {
      // Check if user is a manager for this project
      const isManagerForProject = req.user.role === 'manager' && 
        req.user.projects.some(p => p.toString() === teamData.project._id.toString());
      
      if (!isManagerForProject) {
        return res.status(403).json({ message: 'Not authorized to update status for this user' });
      }
    }
    
    // Check if user is in the team
    const isMember = await User.exists({ _id: user, teams: team });
    if (!isMember) {
      return res.status(400).json({ message: 'User is not a member of this team' });
    }

    // Check if status already exists for this date and user
    const existingStatus = await Status.findOne({
      user,
      team,
      date: {
        $gte: new Date(date).setHours(0, 0, 0, 0),
        $lte: new Date(date).setHours(23, 59, 59, 999)
      }
    });

    let status;

    if (existingStatus) {
      // Update existing status
      existingStatus.isLeave = isLeave;
      existingStatus.leaveReason = isLeave ? leaveReason : undefined;
      existingStatus.responses = isLeave ? [] : responses;
      existingStatus.updatedBy = req.user._id;
      existingStatus.updatedAt = new Date();
      
      status = await existingStatus.save();
    } else {
      // Create new status update
      status = new Status({
        user,
        team,
        project: teamData.project._id,
        responses: isLeave ? [] : responses,
        date: new Date(date),
        isLeave,
        leaveReason: isLeave ? leaveReason : undefined,
        updatedBy: req.user._id,
      });

      await status.save();
    }

    // Populate the response
    await status.populate([
      { path: 'user', select: 'name email' },
      { path: 'team', select: 'name' },
      { path: 'project', select: 'name' },
      { path: 'responses.question', select: 'text' },
      { path: 'updatedBy', select: 'name' }
    ]);

    res.status(201).json(status);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   GET /api/status
// @desc    Get status updates (filtered by user, team, date)
// @access  Private (Team Member for own, Manager for team)
router.get('/', auth, async (req, res) => {
  try {
    const { user, teams, date, month, startDate, endDate } = req.query;
    let query = {};

    // Apply filters
    if (user) query.user = user;

    if (teams) {
      const teamArray = teams.split(',');
      query.team = { $in: teamArray };
    }

    // Date filters
    if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);

      const end = new Date(date);
      end.setHours(23, 59, 59, 999);

      query.date = { $gte: start, $lte: end };
    } else if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);

      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);

      query.date = { $gte: start, $lte: end };
    } else if (startDate && !endDate) {
      // Filter from startDate to today
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);

      const end = new Date();
      end.setHours(23, 59, 59, 999);

      query.date = { $gte: start, $lte: end };
    } else if (!startDate && endDate) {
      // Filter from earliest to endDate
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);

      query.date = { $lte: end };
    } else if (month) {
      const [year, monthIndex] = month.split('-');
      const start = new Date(year, parseInt(monthIndex) - 1, 1);
      const end = new Date(year, parseInt(monthIndex), 0);
      end.setHours(23, 59, 59, 999);

      query.date = { $gte: start, $lte: end };
    }

    // Access control
    if (req.user.role === 'employee') {
      query.user = req.user._id;
    } else if (req.user.role === 'manager') {
      if (!teams) {
        const accessibleTeams = await Team.find({ project: { $in: req.user.projects } });
        const teamIds = accessibleTeams.map(team => team._id);
        query.team = { $in: teamIds };
      }
    }

    const statuses = await Status.find(query)
      .sort({ date: -1 })
      .populate('user', 'name email')
      .populate('team', 'name')
      .populate('project', 'name')
      .populate('responses.question', 'text')
      .populate('updatedBy', 'name');

    res.json(statuses);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   GET /api/status/:id
// @desc    Get status by ID
// @access  Private (Team Member for own, Manager for team)
router.get('/:id', auth, async (req, res) => {
  try {
    const status = await Status.findById(req.params.id)
      .populate('user', 'name email')
      .populate('team', 'name')
      .populate('project', 'name')
      .populate('responses.question', 'text')
      .populate('updatedBy', 'name');
    
    if (!status) {
      return res.status(404).json({ message: 'Status not found' });
    }
    
    // Check access permissions
    const isOwnStatus = status.user._id.toString() === req.user._id.toString();
    
    if (req.user.role === 'employee' && !isOwnStatus) {
      return res.status(403).json({ message: 'Not authorized to view this status' });
    }
    
    if (req.user.role === 'manager') {
      const isProjectManager = req.user.projects.some(p => 
        p.toString() === status.project._id.toString()
      );
      
      if (!isProjectManager && !isOwnStatus) {
        return res.status(403).json({ message: 'Not authorized to view this status' });
      }
    }
    
    res.json(status);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   PUT /api/status/:id
// @desc    Update status
// @access  Private (Team Member for own, Manager for team)
router.put('/:id', [
  auth,
  [
    check('date', 'Date is required').optional().isISO8601(),
    check('isLeave').optional().isBoolean(),
    check('leaveReason').if(check('isLeave').equals('true')).not().isEmpty().withMessage('Leave reason is required when marking leave'),
    check('responses').if(check('isLeave').not().equals('true')).optional().isArray().not().isEmpty().withMessage('Responses are required for status updates'),
    check('responses.*.question').if(check('isLeave').not().equals('true')).optional().not().isEmpty().withMessage('Question ID is required for each response'),
    check('responses.*.answer').if(check('isLeave').not().equals('true')).optional().not().isEmpty().withMessage('Answer is required for each response')
  ]
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const status = await Status.findById(req.params.id);
    
    if (!status) {
      return res.status(404).json({ message: 'Status not found' });
    }

    // Check date restrictions if date is being updated
    // if (req.body.date && !isDateAllowed(req.body.date)) {
    //   return res.status(400).json({ 
    //     message: 'You can only update status for today or the last two days' 
    //   });
    // }
    
    // Check permissions
    const isOwnStatus = status.user.toString() === req.user._id.toString();
    
    if (req.user.role === 'employee' && !isOwnStatus) {
      return res.status(403).json({ message: 'Not authorized to update this status' });
    }
    
    if (req.user.role === 'manager') {
      const team = await Team.findById(status.team).populate('project');
      const isProjectManager = req.user.projects.some(p => 
        p.toString() === team.project._id.toString()
      );
      
      if (!isProjectManager && !isOwnStatus) {
        return res.status(403).json({ message: 'Not authorized to update this status' });
      }
    }
    
    // Update status fields
    const { responses, date, isLeave, leaveReason } = req.body;
    
    if (typeof isLeave === 'boolean') {
      status.isLeave = isLeave;
      if (isLeave) {
        status.leaveReason = leaveReason;
        status.responses = [];
      } else {
        status.leaveReason = undefined;
        if (responses) status.responses = responses;
      }
    } else {
      if (responses) status.responses = responses;
    }
    
    if (date) status.date = new Date(date);
    
    status.updatedBy = req.user._id;
    status.updatedAt = Date.now();
    
    await status.save();
    
    // Populate the response
    await status.populate([
      { path: 'user', select: 'name email' },
      { path: 'team', select: 'name' },
      { path: 'project', select: 'name' },
      { path: 'responses.question', select: 'text' },
      { path: 'updatedBy', select: 'name' }
    ]);
    
    res.json(status);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   DELETE /api/status/:id
// @desc    Delete status
// @access  Private (Admin, Manager for team)
router.delete('/:id', [auth, isManager], async (req, res) => {
  try {
    const status = await Status.findById(req.params.id);
    
    if (!status) {
      return res.status(404).json({ message: 'Status not found' });
    }
    
    // Check if user is admin or manager for this project
    if (req.user.role === 'manager') {
      const team = await Team.findById(status.team).populate('project');
      const isProjectManager = req.user.projects.some(p => 
        p.toString() === team.project._id.toString()
      );
      
      if (!isProjectManager) {
        return res.status(403).json({ message: 'Not authorized to delete this status' });
      }
    }
    
    await status.deleteOne();
    
    res.json({ message: 'Status removed' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server error');
  }
});

// @route   GET /api/status/export
// @desc    Export status updates to Excel
// @access  Private (Manager)
router.get('/export/excel', [auth, isManager], async (req, res) => {
  try {
    const { team, user, date, month } = req.query;
    let query = {};

    // Apply filters
    if (user) query.user = user;
    if (team) query.team = team;

    // Date filters
    if (date) {
      const startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);

      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);

      query.date = { $gte: startDate, $lte: endDate };
    } else if (month) {
      const [year, monthIndex] = month.split('-');
      const startDate = new Date(year, parseInt(monthIndex) - 1, 1);
      const endDate = new Date(year, parseInt(monthIndex), 0, 23, 59, 59, 999);

      query.date = { $gte: startDate, $lte: endDate };
    }

    // Access control for managers
    if (req.user.role === 'manager') {
      if (!team) {
        const accessibleTeams = await Team.find({ project: { $in: req.user.projects } });
        const teamIds = accessibleTeams.map(team => team._id);
        query.team = { $in: teamIds };
      } else {
        const teamData = await Team.findById(team).populate('project');
        const hasAccess = req.user.projects.some(p =>
          p.toString() === teamData.project._id.toString()
        );

        if (!hasAccess) {
          return res.status(403).json({
            message: 'Not authorized to export data for this team'
          });
        }
      }
    }

    const statuses = await Status.find(query)
      .sort({ date: 1 })
      .populate('user', 'name')
      .populate('team', 'name')
      .populate('responses.question', 'text');

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Status Report');

    const teamUserMap = new Map();
    const dateSet = new Set();
    const questionMap = new Map();

    statuses.forEach(status => {
      const teamId = status.team._id.toString();
      const userId = status.user._id.toString();
      const dateStr = status.date.toISOString().split('T')[0];

      dateSet.add(dateStr);

      if (!teamUserMap.has(teamId)) {
        teamUserMap.set(teamId, {
          name: status.team.name,
          users: new Map()
        });
      }

      const team = teamUserMap.get(teamId);
      if (!team.users.has(userId)) {
        team.users.set(userId, {
          name: status.user.name,
          responses: {},
          leaves: {}
        });
      }

      const user = team.users.get(userId);

      if (status.isLeave) {
        user.leaves[dateStr] = status.leaveReason || 'Leave';
      } else {
        status.responses.forEach(response => {
          const questionId = response.question._id.toString();
          const questionText = response.question.text;

          if (!questionMap.has(questionId)) {
            questionMap.set(questionId, {
              id: questionId,
              text: questionText
            });
          }

          if (!user.responses[questionId]) {
            user.responses[questionId] = {};
          }

          user.responses[questionId][dateStr] = response.answer;
        });
      }
    });

    const sortedDates = Array.from(dateSet).sort();
    const questions = Array.from(questionMap.values());

    const columns = [
      { header: 'Team', key: 'team', width: 15 },
      { header: 'User', key: 'user', width: 20 },
      { header: 'Question', key: 'question', width: 30 }
    ];

    sortedDates.forEach(dateStr => {
      columns.push({
        header: dateStr,
        key: dateStr,
        width: 20
      });
    });

    worksheet.columns = columns;

    for (const [teamId, team] of teamUserMap.entries()) {
      let isFirstUserInTeam = true;

      for (const [userId, user] of team.users.entries()) {
        let isFirstQuestionForUser = true;

        questions.forEach((question, questionIndex) => {
          const row = {
            team: (isFirstUserInTeam && questionIndex === 0) ? team.name : '',
            user: (isFirstQuestionForUser && questionIndex === 0) ? user.name : '',
            question: question.text
          };

          sortedDates.forEach(dateStr => {
            if (user.leaves[dateStr]) {
              row[dateStr] = user.leaves[dateStr];
            } else {
              row[dateStr] = user.responses[question.id]?.[dateStr] || '';
            }
          });

          const addedRow = worksheet.addRow(row);

          // Highlight specific leave cells only
          sortedDates.forEach((dateStr, i) => {
            const cellIndex = columns.findIndex(col => col.key === dateStr) + 1;
            const cell = addedRow.getCell(cellIndex);
            const value = cell.value?.toString().toLowerCase();
            if (['leave', 'sick leave', 'personal'].includes(value)) {
              cell.fill = {
                type: 'pattern',
                pattern: 'solid',
                fgColor: { argb: 'FFFFA500' }
              };
            }
          });
        });

        isFirstUserInTeam = false;
      }
    }

    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.alignment = {
      vertical: 'middle',
      horizontal: 'center'
    };

    // Add borders to all cells
    worksheet.eachRow((row) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
      });
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=status-report.xlsx'
    );

    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Excel export error:', error);
    res.status(500).json({
      message: 'Server error during export',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


export default router;