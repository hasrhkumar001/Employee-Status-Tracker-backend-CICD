import mongoose from 'mongoose';

const StatusSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  team: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Team',
    required: true
  },
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true
  },
  date: {
    type: Date,
    required: true,
    default: Date.now
  },
  isLeave: {
    type: Boolean,
    default: false
  },
  leaveReason: {
    type: String,
    required: function() {
      return this.isLeave;
    }
  },
  responses: [{
    question: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Question',
      required: function() {
        return !this.parent().isLeave;
      }
    },
    answer: {
      type: String,
      required: function() {
        return !this.parent().isLeave;
      },
      trim: true
    }
  }],
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Index for efficient queries
StatusSchema.index({ user: 1, team: 1, date: 1 }, { unique: true });
StatusSchema.index({ team: 1, date: -1 });
StatusSchema.index({ project: 1, date: -1 });

// Update the updatedAt field before saving
StatusSchema.pre('save', function(next) {
  if (this.isModified() && !this.isNew) {
    this.updatedAt = Date.now();
  }
  next();
});

// Virtual for formatted date
StatusSchema.virtual('formattedDate').get(function() {
  return this.date.toLocaleDateString();
});

// Method to check if status is for today
StatusSchema.methods.isToday = function() {
  const today = new Date();
  const statusDate = new Date(this.date);
  return today.toDateString() === statusDate.toDateString();
};

// Method to check if status can be edited (within allowed date range)
StatusSchema.methods.canBeEdited = function() {
  const today = new Date();
  const statusDate = new Date(this.date);
  const twoDaysAgo = new Date(today);
  twoDaysAgo.setDate(today.getDate() - 2);
  
  return statusDate >= twoDaysAgo && statusDate <= today;
};

// Static method to get status summary for a date range
StatusSchema.statics.getStatusSummary = async function(teamId, startDate, endDate) {
  return this.aggregate([
    {
      $match: {
        team: mongoose.Types.ObjectId(teamId),
        date: {
          $gte: new Date(startDate),
          $lte: new Date(endDate)
        }
      }
    },
    {
      $group: {
        _id: {
          user: '$user',
          date: { $dateToString: { format: "%Y-%m-%d", date: "$date" } }
        },
        isLeave: { $first: '$isLeave' },
        leaveReason: { $first: '$leaveReason' },
        responseCount: { 
          $sum: { 
            $cond: [{ $eq: ['$isLeave', false] }, { $size: '$responses' }, 0] 
          } 
        }
      }
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id.user',
        foreignField: '_id',
        as: 'user'
      }
    },
    {
      $unwind: '$user'
    },
    {
      $project: {
        date: '$_id.date',
        user: {
          _id: '$user._id',
          name: '$user.name',
          email: '$user.email'
        },
        isLeave: 1,
        leaveReason: 1,
        responseCount: 1
      }
    },
    {
      $sort: { date: 1, 'user.name': 1 }
    }
  ]);
};

export default mongoose.model('Status', StatusSchema);