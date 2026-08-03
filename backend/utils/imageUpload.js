const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure upload directories exist
const createUploadDirs = () => {
  const dirs = [
    'uploads/communities',
    'uploads/discussions',
    'uploads/profiles'
  ];
  
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
};

// Initialize upload directories
createUploadDirs();

// Configure multer for community profile photos
const communityStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/communities/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'community-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// Configure multer for discussion profile photos
const discussionStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/discussions/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'discussion-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// File filter for image validation
const imageFileFilter = (req, file, cb) => {
  // Check file type
  const allowedTypes = /jpeg|jpg|png/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (mimetype && extname) {
    return cb(null, true);
  } else {
    cb(new Error('Only .jpg, .jpeg, and .png files are allowed'));
  }
};

// Community profile photo upload configuration
const communityPhotoUpload = multer({
  storage: communityStorage,
  limits: {
    fileSize: 2 * 1024 * 1024 // 2MB limit
  },
  fileFilter: imageFileFilter
});

// Discussion profile photo upload configuration
const discussionPhotoUpload = multer({
  storage: discussionStorage,
  limits: {
    fileSize: 2 * 1024 * 1024 // 2MB limit
  },
  fileFilter: imageFileFilter
});

// Helper function to delete old image file
const deleteOldImage = (imagePath) => {
  if (imagePath && fs.existsSync(imagePath)) {
    try {
      fs.unlinkSync(imagePath);
    } catch (error) {
      console.error('Error deleting old image:', error);
    }
  }
};

module.exports = {
  communityPhotoUpload,
  discussionPhotoUpload,
  deleteOldImage,
  createUploadDirs
};
