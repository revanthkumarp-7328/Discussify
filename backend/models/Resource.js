const mongoose = require('mongoose');

const resourceSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Resource title is required'],
    trim: true,
    minlength: [3, 'Title must be at least 3 characters long'],
    maxlength: [200, 'Title cannot exceed 200 characters']
  },
  description: {
    type: String,
    required: [true, 'Resource description is required'],
    maxlength: [1000, 'Description cannot exceed 1000 characters']
  },
  type: {
    type: String,
    required: true,
    enum: ['article', 'video', 'document', 'link']
  },
  url: {
    type: String,
    validate: {
      validator: function(v) {
        return this.type === 'link' ? /^https?:\/\/.+/.test(v) : true;
      },
      message: 'Please provide a valid URL for link resources'
    }
  },
  file: {
    filename: String,
    originalName: String,
    mimetype: String,
    size: Number,
    path: String
  },
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  community: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Community',
    required: true
  },
  tags: [{
    type: String,
    trim: true,
    lowercase: true
  }],
  category: {
    type: String,
    enum: ['Educational', 'Tutorial', 'News', 'Research', 'Tool', 'Reference', 'Science', 'Technology', 'Other'],
    default: 'Other'
  },
  likes: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    likedAt: {
      type: Date,
      default: Date.now
    }
  }],
  downloads: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    downloadedAt: {
      type: Date,
      default: Date.now
    }
  }],
  comments: [{
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    content: {
      type: String,
      required: true,
      maxlength: [500, 'Comment cannot exceed 500 characters']
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  isApproved: {
    type: Boolean,
    default: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  metadata: {
    fileSize: Number,
    duration: Number, // for videos
    pageCount: Number, // for documents
    resolution: String // for images/videos
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for better query performance
resourceSchema.index({ community: 1, createdAt: -1 });
resourceSchema.index({ author: 1 });
resourceSchema.index({ type: 1 });
resourceSchema.index({ tags: 1 });
resourceSchema.index({ category: 1 });

// Virtual for like count
resourceSchema.virtual('likeCount').get(function() {
  return this.likes.length;
});

// Virtual for download count
resourceSchema.virtual('downloadCount').get(function() {
  return this.downloads.length;
});

// Virtual for comment count
resourceSchema.virtual('commentCount').get(function() {
  return this.comments.length;
});

module.exports = mongoose.model('Resource', resourceSchema);
