const mongoose = require('mongoose');

const communitySchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Community name is required'],
    unique: true,
    trim: true,
    minlength: [3, 'Community name must be at least 3 characters long'],
    maxlength: [100, 'Community name cannot exceed 100 characters']
  },
  description: {
    type: String,
    required: [true, 'Community description is required'],
    maxlength: [1000, 'Description cannot exceed 1000 characters']
  },
  category: {
    type: String,
    required: [true, 'Community category is required'],
    enum: ['Technology', 'Science', 'Arts', 'Sports', 'Business', 'Education', 'Health', 'Entertainment', 'Other']
  },
  isPrivate: {
    type: Boolean,
    default: false
  },
  coverImage: {
    type: String,
    default: null
  },
  profilePhoto: {
    type: String,
    default: null
  },
  creator: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  moderators: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  members: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    joinedAt: {
      type: Date,
      default: Date.now
    },
    role: {
      type: String,
      enum: ['member', 'moderator', 'admin'],
      default: 'member'
    }
  }],
  invitations: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    invitedAt: {
      type: Date,
      default: Date.now
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined'],
      default: 'pending'
    }
  }],
  joinRequests: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    requestedAt: {
      type: Date,
      default: Date.now
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending'
    },
    message: {
      type: String,
      maxlength: [500, 'Request message cannot exceed 500 characters']
    }
  }],
  rules: [{
    title: {
      type: String,
      required: true,
      maxlength: [100, 'Rule title cannot exceed 100 characters']
    },
    description: {
      type: String,
      required: true,
      maxlength: [500, 'Rule description cannot exceed 500 characters']
    }
  }],
  tags: [{
    type: String,
    trim: true,
    lowercase: true
  }],
  settings: {
    allowMemberPosts: {
      type: Boolean,
      default: true
    },
    requireApproval: {
      type: Boolean,
      default: false
    },
    allowResourceSharing: {
      type: Boolean,
      default: true
    }
  },
  stats: {
    memberCount: {
      type: Number,
      default: 0
    },
    discussionCount: {
      type: Number,
      default: 0
    },
    resourceCount: {
      type: Number,
      default: 0
    }
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Indexes for better query performance
communitySchema.index({ name: 1 });
communitySchema.index({ category: 1 });
communitySchema.index({ tags: 1 });
communitySchema.index({ creator: 1 });
communitySchema.index({ 'members.user': 1 });

// Update member count only when 'members' is modified
communitySchema.pre('save', function(next) {
  if (!this.isModified('members')) return next();
  const memberCount = Array.isArray(this.members) ? this.members.length : 0;
  this.set('stats.memberCount', memberCount);
  next();
});

// Virtual for getting active members
communitySchema.virtual('activeMembers').get(function() {
  return this.members.filter(member => member.role !== 'banned');
});

// Method to check if user has pending join request
communitySchema.methods.hasPendingRequest = function(userId) {
  return this.joinRequests.some(
    request => request.user.toString() === userId.toString() && request.status === 'pending'
  );
};

// Method to cancel join request
communitySchema.methods.cancelJoinRequest = async function(userId) {
  const requestIndex = this.joinRequests.findIndex(
    request => request.user.toString() === userId.toString() && request.status === 'pending'
  );

  if (requestIndex === -1) {
    throw new Error('No pending join request found');
  }

  this.joinRequests.splice(requestIndex, 1);
  await this.save();
  return this;
};

module.exports = mongoose.model('Community', communitySchema);
