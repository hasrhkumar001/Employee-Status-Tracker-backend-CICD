import mongoose from 'mongoose';

const QuestionSchema = new mongoose.Schema({
  text: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    enum: ['text', 'multiple_choice', 'single_choice'],
    default: 'text'
  },
  options: [{
    text: {
      type: String,
      required: true,
      trim: true
    },
    order: {
      type: Number,
      default: 0
    }
  }],
  isCommon: {
    type: Boolean,
    default: false
  },
  teams: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Team'
  }],
  active: {
    type: Boolean,
    default: true
  },
  order: {
    type: Number,
    default: 0
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
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

// Validate that choice questions have options
QuestionSchema.pre('save', function(next) {
  if ((this.type === 'multiple_choice' || this.type === 'single_choice') && 
      (!this.options || this.options.length === 0)) {
    next(new Error('Choice questions must have at least one option'));
  } else if (this.type === 'text' && this.options && this.options.length > 0) {
    // Clear options for text questions
    this.options = [];
  }
  next();
});

const Question = mongoose.model('Question', QuestionSchema);

export default Question;