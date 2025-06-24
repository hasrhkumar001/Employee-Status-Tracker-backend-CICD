import express from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import StatusUpdate from '../models/Status.js';
import Team from '../models/Team.js';
import Project from '../models/Project.js';
import User from '../models/User.js';
import Question from '../models/Question.js';
import { auth, isManager } from '../middleware/auth.js';

const router = express.Router();

// Configure multer for file upload with better error handling
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        console.log('File details:', {
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size
        });

        // Accept Excel files with more comprehensive MIME type checking
        const allowedMimeTypes = [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
            'application/vnd.ms-excel', // .xls
            'application/excel',
            'application/x-excel',
            'application/x-msexcel'
        ];

        const fileExtension = file.originalname.toLowerCase().split('.').pop();
        const allowedExtensions = ['xlsx', 'xls'];

        if (allowedMimeTypes.includes(file.mimetype) || allowedExtensions.includes(fileExtension)) {
            cb(null, true);
        } else {
            cb(new Error(`Invalid file type. Only Excel files are allowed. Received: ${file.mimetype}`), false);
        }
    },
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
        fieldSize: 10 * 1024 * 1024 // 10MB field size limit
    }
});

// Helper function to convert date format (e.g., '5-May' to proper Date)
const convertDateFormat = (dateStr) => {
    try {
        const currentYear = new Date().getFullYear();

        // Handle different date formats
        if (dateStr.includes('-')) {
            const [day, month] = dateStr.split('-');
            const monthMap = {
                'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
                'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
            };

            const monthIndex = monthMap[month];
            if (monthIndex !== undefined) {
                return new Date(currentYear, monthIndex, parseInt(day) || 1);
            }
        }

        // If date parsing fails, try to parse as standard date
        const parsedDate = new Date(dateStr);
        if (!isNaN(parsedDate.getTime())) {
            return parsedDate;
        }

        console.warn(`Could not parse date: ${dateStr}, using current date`);
        return new Date();
    } catch (error) {
        console.warn(`Error converting date: ${dateStr}`, error);
        return new Date(); // Return current date as fallback
    }
};

// Helper function to process Excel data according to transformation logic
const processExcelData = (worksheetData) => {
    const processed = [];
    let currentTeam = '';
    let currentEmployee = '';
    let currentQuestion = '';
    const errorDetails = [];

    console.log(`Processing ${worksheetData.length} rows from Excel`);

    worksheetData.forEach((row, index) => {
        const rowNumber = index + 2; // considering header is row 1

        try {
            if (!row || Object.keys(row).length === 0) return;

            const teamKeys = ['Team', 'Team #', 'TeamName', 'Team Name'];
            const employeeKeys = ['Employee', 'Resources Names', 'Resource Names', 'User', 'UserName', 'User Name', 'Name'];
            const questionKeys = ['Question', 'Questions', 'Task', 'Activity'];

            const teamValue = teamKeys.reduce((val, key) => val || row[key], null);
            const employeeValue = employeeKeys.reduce((val, key) => val || row[key], null);
            const questionValue = questionKeys.reduce((val, key) => val || row[key], null);

            // Update current team
            if (teamValue && teamValue.toString().trim() !== '') {
                const teamStr = teamValue.toString().trim();
                if (teamStr !== '#NAME?' && teamStr !== 'undefined') {
                    currentTeam = teamStr;
                }
            }

            // Update current employee
            if (employeeValue && typeof employeeValue === 'string' && employeeValue.trim() !== '') {
                currentEmployee = employeeValue.trim();
            }

            // Update current question
            if (questionValue && typeof questionValue === 'string' && questionValue.trim() !== '') {
                currentQuestion = questionValue.trim();
            }

            // Validate
            const missingFields = [];
            if (!currentTeam) missingFields.push('Team');
            if (!currentEmployee) missingFields.push('Employee');
            if (!currentQuestion) missingFields.push('Question');

            if (missingFields.length > 0) {
                errorDetails.push({ row: rowNumber, missingFields });
                return;
            }

            // Process date columns (D onward)
            // All column keys for this row
            const keys = Object.keys(row);

            // Smart detection of date columns
            const knownFields = [...teamKeys, ...employeeKeys, ...questionKeys].map(k => k.toLowerCase());
            const dateColumns = keys.filter(key =>
                !knownFields.includes(key.toLowerCase()) &&
                key.match(/\d{1,2}[-/ ][A-Za-z]{3,}/)
            );

            dateColumns.forEach((dateColumn) => {
                const answer = row[dateColumn];
                if (answer && answer.toString().trim() !== '' && answer.toString().trim() !== 'undefined') {
                    const answerStr = answer.toString().trim();

                    const isLeave = ['leave', 'absent', 'sick leave', 'off', 'optional holiday'].includes(answerStr.toLowerCase());
                    processed.push({
                        teamName: currentTeam,
                        userName: currentEmployee,
                        question: currentQuestion,
                        date: dateColumn,
                        answer: answerStr,
                        isLeave: isLeave,
                        leaveReason: isLeave ? answerStr : null
                    });
                }
            });

        } catch (error) {
            console.warn(`Error processing row ${rowNumber}:`, error);
        }
    });

    console.log(`Processed ${processed.length} rows`);

    if (processed.length === 0) {
        const error = new Error('No valid data found');
        error.details = errorDetails;
        throw error;
    }

    return processed;
};



// Helper function to transform processed data into status entries per employee per date
const transformToStatusEntries = (processedData) => {
    const statusMap = new Map();

    processedData.forEach(item => {
        // Create unique key for each employee + date combination
        const key = `${item.teamName}|${item.userName}|${item.date}`;

        if (!statusMap.has(key)) {
            statusMap.set(key, {
                teamName: item.teamName,
                userName: item.userName,
                date: item.date,
                responses: [],
                isLeave: false,
                leaveReason: null
            });
        }

        const entry = statusMap.get(key);

        // If any answer indicates leave, mark the entire day as leave
        if (item.isLeave) {
            entry.isLeave = true;
            entry.leaveReason = item.answer;
        } else {
            // Add the question-answer pair to responses
            entry.responses.push({
                question: item.question,
                answer: item.answer
            });
        }
    });

    return Array.from(statusMap.values());
};

// Helper function to find or create entities with improved error handling
const findOrCreateEntities = async (statusEntries, createdBy) => {
    const userMap = new Map();
    const teamMap = new Map();
    const questionMap = new Map();

    // Get unique names
    const uniqueUserNames = [...new Set(statusEntries.map(entry => entry.userName))];
    const uniqueTeamNames = [...new Set(statusEntries.map(entry => entry.teamName))];
    const uniqueQuestions = [...new Set(
        statusEntries.flatMap(entry => entry.responses.map(r => r.question))
    )];

    console.log('Creating entities:', {
        users: uniqueUserNames.length,
        teams: uniqueTeamNames.length,
        questions: uniqueQuestions.length
    });

    // Find or create users
    for (const userName of uniqueUserNames) {
        try {
            let user = await User.findOne({ name: userName });
            if (!user) {
                // Create user with default values
                const nameParts = userName.trim().split(/\s+/);
                let email = '';
                if (nameParts.length === 1) {
                    email = `${nameParts[0].toLowerCase()}@idsil.com`;
                } else {
                    const firstName = nameParts[0].toLowerCase();
                    const lastInitial = nameParts[nameParts.length - 1][0].toLowerCase();
                    email = `${firstName}.${lastInitial}@idsil.com`;
                }
                user = new User({
                    name: userName,
                    email: email,
                    password: '12345678', // This should be changed by the user
                    role: 'employee',
                    createdBy: createdBy
                });
                await user.save();
                console.log(`Created new user: ${userName}`);
            }
            userMap.set(userName, user._id);
        } catch (userError) {
            console.error(`Error creating user ${userName}:`, userError);
            // Continue processing other users
        }
    }

    // Get or create default project for team creation
    let defaultProject = await Project.findOne({ active: true });
    if (!defaultProject) {
        // Create a default project if none exists
        defaultProject = new Project({
            name: 'Default Project',
            description: 'Auto-created default project for Excel imports',
            createdBy: createdBy,
            active: true
        });
        await defaultProject.save();
        console.log('Created default project');
    }

    // Find or create teams
    for (const teamName of uniqueTeamNames) {
        try {
            let team = await Team.findOne({ name: teamName });
            if (!team) {
                team = new Team({
                    name: teamName,
                    description: `Auto-created team: ${teamName}`,
                    project: defaultProject._id,
                    members: [],
                    createdBy: createdBy,
                    active: true
                });
                await team.save();
                console.log(`Created new team: ${teamName}`);
            }
            teamMap.set(teamName, team._id);

            // Add users to team if not already members
            const teamUserIds = statusEntries
                .filter(entry => entry.teamName === teamName)
                .map(entry => userMap.get(entry.userName))
                .filter((userId, index, array) => array.indexOf(userId) === index && userId); // Remove duplicates and nulls

            if (teamUserIds.length > 0) {
                await Team.findByIdAndUpdate(team._id, {
                    $addToSet: { members: { $each: teamUserIds } }
                });

                // Update users with team membership
                await User.updateMany(
                    { _id: { $in: teamUserIds } },
                    { $addToSet: { teams: team._id } }
                );
            }
        } catch (teamError) {
            console.error(`Error creating team ${teamName}:`, teamError);
        }
    }

    // Find or create questions
    for (const questionText of uniqueQuestions) {
        try {
            let question = await Question.findOne({ text: questionText });
            if (!question) {
                question = new Question({
                    text: questionText,
                    type: 'text',
                    isCommon: true,
                    active: true,
                    createdBy: createdBy
                });
                await question.save();
                console.log(`Created new question: ${questionText}`);
            }
            questionMap.set(questionText, question._id);
        } catch (questionError) {
            console.error(`Error creating question ${questionText}:`, questionError);
        }
    }

    return { userMap, teamMap, questionMap, defaultProject };
};

// POST route for uploading Excel file with improved transformation logic
router.post('/upload-status', auth, isManager, upload.single('excelFile'), async (req, res) => {
    try {
        console.log('Excel upload request received');

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded'
            });
        }

        console.log('Processing file:', {
            filename: req.file.originalname,
            size: req.file.size,
            mimetype: req.file.mimetype
        });

        // Parse Excel file
        const workbook = new ExcelJS.Workbook();

        try {
            await workbook.xlsx.load(req.file.buffer);
        } catch (loadError) {
            console.error('Excel file load error:', loadError);
            return res.status(400).json({
                success: false,
                message: 'Invalid Excel file format. Please ensure the file is not corrupted and is a valid Excel file (.xlsx or .xls)',
                error: loadError.message
            });
        }

        // Get the first worksheet
        const worksheet = workbook.getWorksheet(1) || workbook.worksheets[0];
        if (!worksheet) {
            return res.status(400).json({
                success: false,
                message: 'No worksheet found in Excel file. Please ensure the file contains at least one worksheet with data.'
            });
        }

        console.log(`Processing worksheet: ${worksheet.name}, Row count: ${worksheet.rowCount}`);

        // Convert worksheet to JSON
        const worksheetData = [];
        const headers = [];

        // Get headers from first row
        const headerRow = worksheet.getRow(1);
        headerRow.eachCell((cell, index) => {
            const cellValue = cell.value;
            if (cellValue !== null && cellValue !== undefined) {
                headers[index] = cellValue.toString().trim() || `Column${index}`;
            } else {
                headers[index] = `Column${index}`;
            }
        });

        console.log('Headers found:', headers.filter(h => h));

        // Process data rows (skip header row)
        let processedRowCount = 0;
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return; // Skip header row

            try {
                const rowData = {};
                let hasData = false;

                row.eachCell((cell, colNumber) => {
                    const header = headers[colNumber];
                    if (header) {
                        const cellValue = cell.value;
                        if (cellValue !== null && cellValue !== undefined) {
                            rowData[header] = cellValue;
                            hasData = true;
                        }
                    }
                });

                if (hasData) {
                    worksheetData.push(rowData);
                    processedRowCount++;
                }
            } catch (rowError) {
                console.warn(`Error processing row ${rowNumber}:`, rowError);
            }
        });

        console.log(`Processed ${processedRowCount} rows with data`);

        if (worksheetData.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No data rows found in Excel file. Please ensure the file contains data beyond the header row.'
            });
        }

        // Step 1: Process Excel data according to transformation logic
        const processedData = processExcelData(worksheetData);

        if (processedData.length === 0) {
            // Find the first row with missing or invalid data for detailed error
            let errorDetails = [];
            worksheetData.forEach((row, idx) => {
                const teamKeys = ['Team', 'Team #', 'TeamName', 'Team Name'];
                const employeeKeys = ['Employee', 'Resources Names', 'Resource Names', 'User', 'UserName', 'User Name', 'Name'];
                const questionKeys = ['Question', 'Questions', 'Task', 'Activity'];
                const teamValue = teamKeys.reduce((val, key) => val || row[key], null);
                const employeeValue = employeeKeys.reduce((val, key) => val || row[key], null);
                const questionValue = questionKeys.reduce((val, key) => val || row[key], null);

                if (!teamValue || !employeeValue || !questionValue) {
                    errorDetails.push({
                        row: idx + 2, // +2 because worksheetData skips header row and Excel rows are 1-indexed
                        missingFields: [
                            !teamValue ? 'Team' : null,
                            !employeeValue ? 'Employee' : null,
                            !questionValue ? 'Question' : null
                        ].filter(Boolean)
                    });
                }
            });

            return res.status(400).json({
                success: false,
                message: 'No valid data found in Excel file. Please check the format: Team (Column A), Employee (Column B), Question (Column C), and date columns should contain valid data.',
                errorDetails: errorDetails.length > 0 ? errorDetails : 'All rows are missing required fields or are invalid.'
            });
        }

        // Step 2: Transform into status entries (one per employee per date)
        const statusEntries = transformToStatusEntries(processedData);

        console.log(`Created ${statusEntries.length} status entries from ${processedData.length} data points`);

        // Step 3: Find or create users, teams, and questions
        const { userMap, teamMap, questionMap, defaultProject } = await findOrCreateEntities(statusEntries, req.user._id);

        // Step 4: Check authorization for teams
        if (req.user.role !== 'admin') {
            const userProjects = req.user.projects || [];
            const uploadTeamIds = Array.from(teamMap.values());

            const teams = await Team.find({ _id: { $in: uploadTeamIds } }).populate('project');
            const unauthorizedTeams = teams.filter(team =>
                !userProjects.some(pid => pid.toString() === team.project._id.toString())
            );

            if (unauthorizedTeams.length > 0) {
                return res.status(403).json({
                    success: false,
                    message: `Not authorized to upload data for teams: ${unauthorizedTeams.map(t => t.name).join(', ')}`
                });
            }
        }

        // Step 5: Create status documents for database
        const statusDocuments = [];

        statusEntries.forEach(entry => {
            try {
                const userId = userMap.get(entry.userName);
                const teamId = teamMap.get(entry.teamName);
                const date = convertDateFormat(entry.date);

                if (!userId || !teamId) {
                    console.warn(`Missing IDs for entry:`, entry);
                    return;
                }

                // Create responses array with question IDs
                const responses = entry.responses
                    .map(response => {
                        const questionId = questionMap.get(response.question);
                        if (questionId) {
                            return {
                                question: questionId,
                                answer: response.answer
                            };
                        }
                        return null;
                    })
                    .filter(response => response !== null);

                statusDocuments.push({
                    user: userId,
                    team: teamId,
                    project: defaultProject._id,
                    date: date,
                    isLeave: entry.isLeave,
                    leaveReason: entry.leaveReason,
                    responses: responses,
                    updatedBy: req.user._id
                });
            } catch (entryError) {
                console.warn('Error processing status entry:', entry, entryError);
            }
        });

        if (statusDocuments.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No valid status documents could be created from the Excel data.'
            });
        }

        // Step 6: Bulk insert/update status documents
        const bulkOps = statusDocuments.map(doc => ({
            updateOne: {
                filter: {
                    user: doc.user,
                    team: doc.team,
                    date: doc.date
                },
                update: { $set: doc },
                upsert: true
            }
        }));

        const result = await StatusUpdate.bulkWrite(bulkOps);

        console.log('Upload completed successfully:', {
            totalDataPoints: processedData.length,
            statusEntries: statusEntries.length,
            statusDocuments: statusDocuments.length,
            insertedCount: result.upsertedCount,
            modifiedCount: result.modifiedCount
        });

        res.json({
            success: true,
            message: 'Excel data uploaded and transformed successfully',
            data: {
                totalDataPoints: processedData.length,
                statusEntries: statusEntries.length,
                statusDocuments: statusDocuments.length,
                insertedCount: result.upsertedCount,
                modifiedCount: result.modifiedCount,
                usersCreated: Array.from(userMap.keys()),
                teamsProcessed: Array.from(teamMap.keys()),
                questionsProcessed: Array.from(questionMap.keys())
            }
        });

    } catch (error) {
        console.error('Excel upload error:', error);

        // Handle specific error types
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: 'File size too large. Maximum size is 10MB.'
            });
        }

        if (error.message && error.message.includes('Only Excel files are allowed')) {
            return res.status(400).json({
                success: false,
                message: 'Only Excel files (.xlsx, .xls) are allowed'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Server error during file upload',
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// POST route for uploading JSON data (alternative to file upload)
router.post('/upload-status-json', auth, isManager, async (req, res) => {
    try {
        const { data } = req.body;

        if (!data || !Array.isArray(data) || data.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No valid data provided. Expected array of status entries.'
            });
        }

        console.log(`Processing ${data.length} status entries from JSON`);

        // Find or create users, teams, and questions
        const { userMap, teamMap, questionMap, defaultProject } = await findOrCreateEntities(data, req.user._id);

        // Check authorization for teams
        if (req.user.role !== 'admin') {
            const userProjects = req.user.projects || [];
            const uploadTeamIds = Array.from(teamMap.values());

            const teams = await Team.find({ _id: { $in: uploadTeamIds } }).populate('project');
            const unauthorizedTeams = teams.filter(team =>
                !userProjects.some(pid => pid.toString() === team.project._id.toString())
            );

            if (unauthorizedTeams.length > 0) {
                return res.status(403).json({
                    success: false,
                    message: `Not authorized to upload data for teams: ${unauthorizedTeams.map(t => t.name).join(', ')}`
                });
            }
        }

        // Create status documents for database
        const statusDocuments = [];

        data.forEach(entry => {
            try {
                const userId = userMap.get(entry.userName);
                const teamId = teamMap.get(entry.teamName);
                const date = convertDateFormat(entry.date);

                if (!userId || !teamId) {
                    console.warn(`Missing IDs for entry:`, entry);
                    return;
                }

                // Create responses array with question IDs
                const responses = (entry.responses || [])
                    .map(response => {
                        const questionId = questionMap.get(response.question);
                        if (questionId) {
                            return {
                                question: questionId,
                                answer: response.answer
                            };
                        }
                        return null;
                    })
                    .filter(response => response !== null);

                statusDocuments.push({
                    user: userId,
                    team: teamId,
                    project: defaultProject._id,
                    date: date,
                    isLeave: entry.isLeave || false,
                    leaveReason: entry.leaveReason,
                    responses: responses,
                    updatedBy: req.user._id
                });
            } catch (entryError) {
                console.warn('Error processing JSON entry:', entry, entryError);
            }
        });

        if (statusDocuments.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No valid status documents could be created from the JSON data.'
            });
        }

        // Bulk insert/update status documents
        const bulkOps = statusDocuments.map(doc => ({
            updateOne: {
                filter: {
                    user: doc.user,
                    team: doc.team,
                    date: doc.date
                },
                update: { $set: doc },
                upsert: true
            }
        }));

        const result = await StatusUpdate.bulkWrite(bulkOps);

        console.log('JSON upload completed successfully:', {
            statusEntries: data.length,
            statusDocuments: statusDocuments.length,
            insertedCount: result.upsertedCount,
            modifiedCount: result.modifiedCount
        });

        res.json({
            success: true,
            message: 'Status data uploaded successfully',
            data: {
                statusEntries: data.length,
                statusDocuments: statusDocuments.length,
                insertedCount: result.upsertedCount,
                modifiedCount: result.modifiedCount,
                usersCreated: Array.from(userMap.keys()),
                teamsProcessed: Array.from(teamMap.keys()),
                questionsProcessed: Array.from(questionMap.keys())
            }
        });

    } catch (error) {
        console.error('JSON upload error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error during data upload',
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// GET route to retrieve status data with filtering options
router.get('/status', auth, async (req, res) => {
    try {
        const {
            teamId,
            userId,
            startDate,
            endDate,
            page = 1,
            limit = 50,
            includeLeave = true
        } = req.query;

        // Build query filter
        const filter = {};

        if (teamId) filter.team = teamId;
        if (userId) filter.user = userId;

        if (startDate || endDate) {
            filter.date = {};
            if (startDate) filter.date.$gte = new Date(startDate);
            if (endDate) filter.date.$lte = new Date(endDate);
        }

        if (includeLeave === 'false') {
            filter.isLeave = false;
        }

        // Check authorization
        if (req.user.role !== 'admin') {
            const userTeams = req.user.teams || [];
            if (teamId && !userTeams.includes(teamId)) {
                return res.status(403).json({
                    success: false,
                    message: 'Not authorized to access this team data'
                });
            }

            if (!teamId) {
                filter.team = { $in: userTeams };
            }
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const statusData = await StatusUpdate.find(filter)
            .populate('user', 'name email')
            .populate('team', 'name')
            .populate('project', 'name')
            .populate('responses.question', 'text type')
            .populate('updatedBy', 'name')
            .sort({ date: -1, 'user.name': 1 })
            .skip(skip)
            .limit(parseInt(limit));

        const totalCount = await StatusUpdate.countDocuments(filter);

        res.json({
            success: true,
            data: statusData,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: totalCount,
                pages: Math.ceil(totalCount / parseInt(limit))
            }
        });

    } catch (error) {
        console.error('Error fetching status data:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching status data',
            error: error.message
        });
    }
});

export default router;