import express from 'express';
import StatusUpdate from '../models/Status.js';
import Team from '../models/Team.js';
import Project from '../models/Project.js';
import User from '../models/User.js';
import Question from '../models/Question.js';
import ExcelJS from 'exceljs';
import { auth, isManager } from '../middleware/auth.js';

const router = express.Router();

router.get('/excel', auth, isManager, async (req, res) => {
  try {
    const { team, teams, user, users, startDate, endDate, month, year } = req.query;

    let teamIds = [];
    let userIds = [];

    if (teams) {
      teamIds = teams.split(',').map((id) => id.trim());
    } else if (team) {
      teamIds = [team];
    }

    if (users) {
      userIds = users.split(',').map((id) => id.trim());
    } else if (user) {
      userIds = [user];
    }

    let dateFilter = {};
    if (startDate && endDate) {
      dateFilter = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    } else if (startDate) {
      dateFilter = {
        $gte: new Date(startDate),
        $lte: new Date(), // up to current date
      };
    } else if (endDate) {
      const end = new Date(endDate);
      const year = end.getFullYear();
      const month = end.getMonth();

      const start = new Date(year, month, 1); // First day of the same month and year

      dateFilter = {
        $gte: start,
        $lte: end,
      };
    }
    else if (month) {
      const [yearStr, monthStr] = month.split("-");
      const year = parseInt(yearStr);
      const monthNum = parseInt(monthStr) - 1;

      const startMonthDate = new Date(year, monthNum, 1); // Start of the selected month
      const endMonthDate = new Date(year, monthNum + 1, 0, 23, 59, 59, 999); // Last day of the month

      dateFilter = { $gte: startMonthDate, $lte: endMonthDate };
    }
    else {
      const today = new Date();
      const startMonthDate = new Date(today.getFullYear(), today.getMonth(), 1);
      const endMonthDate = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);
      dateFilter = { $gte: startMonthDate, $lte: endMonthDate };
    }

    let accessibleTeamIds = [];

    if (req.user.role === 'admin') {
      if (teamIds.length > 0) {
        accessibleTeamIds = teamIds;
      } else {
        const allTeams = await Team.find();
        accessibleTeamIds = allTeams.map((t) => t._id.toString());
      }
    } else if (req.user.role === 'manager') {
      const userProjects = req.user.projects || [];
      let queryTeams = [];

      if (teamIds.length > 0) {
        queryTeams = await Team.find({ _id: { $in: teamIds } }).populate('project');
        const authorizedTeams = queryTeams.filter((team) =>
          userProjects.some((pid) => pid.toString() === team.project._id.toString())
        );

        if (authorizedTeams.length === 0) {
          return res.status(403).json({ message: 'Not authorized to access the requested teams' });
        }

        accessibleTeamIds = authorizedTeams.map((team) => team._id.toString());
      } else {
        const teams = await Team.find({ project: { $in: userProjects } });
        accessibleTeamIds = teams.map((team) => team._id.toString());
      }
    } else {
      return res.status(403).json({ message: 'Only managers and admins can generate reports' });
    }

    let accessibleUserIds = [];
    if (userIds.length > 0) {
      const usersInTeams = await User.find({
        _id: { $in: userIds },
        teams: { $in: accessibleTeamIds },
      }).lean();
      accessibleUserIds = usersInTeams.map((user) => user._id.toString());
      if (accessibleUserIds.length === 0) {
        return res.status(404).json({ message: 'No valid users found for the selected teams' });
      }
    } else if (teamIds.length > 0) {
      const usersInTeams = await User.find({ teams: { $in: accessibleTeamIds } }).lean();
      accessibleUserIds = usersInTeams.map((user) => user._id.toString());
    } else {
      const usersInTeams = await User.find({ teams: { $in: accessibleTeamIds } }).lean();
      accessibleUserIds = usersInTeams.map((user) => user._id.toString());
    }

    if (accessibleTeamIds.length === 0 && accessibleUserIds.length === 0) {
      return res.status(404).json({ message: 'No accessible teams or users found' });
    }

    const query = {
      date: dateFilter,
      team: { $in: accessibleTeamIds },
    };

    if (accessibleUserIds.length > 0) {
      query.user = { $in: accessibleUserIds };
    }

    const statusUpdates = await StatusUpdate.find(query)
      .sort({ date: 1 })
      .populate('user', 'name')
      .populate('team', 'name')
      .populate('responses.question', 'text isCommon')
      .lean();

    const allDates = [];
    const start = new Date(dateFilter.$gte);
    const end = new Date(dateFilter.$lte);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      allDates.push(new Date(d));
    }

    const allQuestions = await Question.find({
      $or: [{ isCommon: true }, { teams: { $in: accessibleTeamIds } }],
    }).lean();

    const reportTeams = await Team.find({ _id: { $in: accessibleTeamIds } }).lean();
    const reportUsers = await User.find({
      _id: { $in: accessibleUserIds },
    }).lean();

    const validTeams = reportTeams.filter((team) => team && team._id);
    const validUsers = reportUsers.filter((user) => user && user._id);

    const updatesByTeamUserDate = {};
    statusUpdates.forEach((update) => {
      if (!update.team || !update.user || !update.team._id || !update.user._id) {
        console.warn('Skipping update with missing team or user data:', update);
        return;
      }

      const teamId = update.team._id.toString();
      const userId = update.user._id.toString();
      const dateStr = update.date.toISOString().split('T')[0];

      if (!updatesByTeamUserDate[teamId]) updatesByTeamUserDate[teamId] = {};
      if (!updatesByTeamUserDate[teamId][userId]) updatesByTeamUserDate[teamId][userId] = {};
      updatesByTeamUserDate[teamId][userId][dateStr] = update.isLeave
        ? { leaveReason: update.leaveReason || 'Leave' }
        : update.responses;
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Status Report');

    const headers = ['Team', 'User', 'Question'];
    allDates.forEach((date) => headers.push(date.toISOString().split('T')[0]));
    worksheet.columns = headers.map((header, i) => ({
      header,
      key: header,
      width: i === 2 ? 50 : i < 3 ? 20 : 15,
    }));

    const isWeekend = (date) => {
      const day = date.getDay();
      return day === 0 || day === 6; // Sunday or Saturday
    };

    const applyCellColor = (cell, value, date) => {
      const lowerValue = (value || '').toString().toLowerCase().trim();
      if (isWeekend(date)) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFD3D3D3' },
        };
      }
      if (lowerValue === 'red') {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: isWeekend(date) ? 'FFD3D3D3' : 'FFFF6B6B' },
        };
      } else if (lowerValue === 'green') {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: isWeekend(date) ? 'FFD3D3D3' : 'FF51CF66' },
        };
      } else if (lowerValue === 'amber') {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: isWeekend(date) ? 'FFD3D3D3' : 'FFFFD43B' },
        };
      }
    };

    const getUserLeaveDates = (teamId, userId) => {
      const leaveDates = {};
      allDates.forEach((date) => {
        const dateStr = date.toISOString().split('T')[0];
        const dayData = updatesByTeamUserDate[teamId]?.[userId]?.[dateStr];
        if (dayData?.leaveReason) {
          leaveDates[dateStr] = dayData.leaveReason;
        }
      });
      return leaveDates;
    };

    for (const team of validTeams) {
      if (!team || !team._id) {
        console.warn('Skipping team with missing data:', team);
        continue;
      }

      const teamId = team._id.toString();
      const usersInTeam = validUsers.filter((u) =>
        u && u._id && u.teams && u.teams.some((tid) => tid && tid.toString() === teamId)
      );

      let isFirstUserInTeam = true;

      for (const user of usersInTeam) {
        if (!user || !user._id) {
          console.warn('Skipping user with missing data:', user);
          continue;
        }

        const userId = user._id.toString();
        const questions = allQuestions.filter((q) =>
          q && q._id && (q.isCommon || (q.teams && q.teams.some((tid) => tid && tid.toString() === teamId)))
        );

        const userLeaveDates = getUserLeaveDates(teamId, userId);
        const hasLeave = Object.keys(userLeaveDates).length > 0;

        let isFirstRowForUser = true;
        const userStartRowNumber = worksheet.rowCount + 1;
        let questionRowsAdded = 0;

        questions.forEach((question, qIndex) => {
          const row = {
            Team: isFirstUserInTeam ? team.name : '',
            User: isFirstRowForUser ? user.name : '',
            Question: question.text,
          };

          allDates.forEach((date) => {
            const dateStr = date.toISOString().split('T')[0];
            const dayData = updatesByTeamUserDate[teamId]?.[userId]?.[dateStr];

            if (dayData?.leaveReason) {
              row[dateStr] = qIndex === 0 ? dayData.leaveReason : '';
            } else {
              const response = Array.isArray(dayData)
                ? dayData.find(
                  (r) => r && r.question && r.question._id && r.question._id.toString() === question._id.toString()
                )
                : null;
              row[dateStr] = response?.answer || '';
            }
          });

          const addedRow = worksheet.addRow(row);
          questionRowsAdded++;

          allDates.forEach((date, dateIndex) => {
            const dateStr = date.toISOString().split('T')[0];
            const cell = addedRow.getCell(headers.indexOf(dateStr) + 1);

            if (userLeaveDates[dateStr]) {
              cell.font = { color: { argb: 'FFFF0000' } };
              cell.alignment = { vertical: 'middle', horizontal: 'center' };
           
            } else {
              applyCellColor(cell, cell.value, date);
            }
          });

          isFirstUserInTeam = false;
          isFirstRowForUser = false;
        });

        if (hasLeave && questionRowsAdded > 1) {
          allDates.forEach((date, dateIndex) => {
            const dateStr = date.toISOString().split('T')[0];
            if (userLeaveDates[dateStr]) {
              const colIndex = 4 + dateIndex;
              const startRow = userStartRowNumber;
              const endRow = userStartRowNumber + questionRowsAdded - 1;

              try {
                worksheet.mergeCells(startRow, colIndex, endRow, colIndex);
                const mergedCell = worksheet.getCell(startRow, colIndex);
                mergedCell.value = userLeaveDates[dateStr];
                mergedCell.font = { color: { argb: 'FFFF0000' }};
                mergedCell.alignment = { vertical: 'middle', horizontal: 'center' };
                
              } catch (error) {
                console.warn(`Error merging cells for leave date ${dateStr}:`, error);
              }
            }
          });
        }

        worksheet.addRow([]);
      }
    }

    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

    worksheet.eachRow((row) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=status-report.xlsx');
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (error) {
    console.error('Excel export error:', error);
    res.status(500).json({
      message: 'Server error',
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
});

export default router;