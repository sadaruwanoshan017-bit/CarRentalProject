// =============================================================
// controllers/fuelController.js
// PURPOSE: Module 4 (Subanujan) - Fuel consumption tracking.
// Performs the core math: fetching the Car's tankCapacity and
// kmPerLiter based on the active Booking ID, then calculating
// tank fullness percentage and remaining drivable kilometres.
// =============================================================

const FuelLog = require('../models/FuelLog');
const Booking = require('../models/Booking');
const Car = require('../models/Car');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// -----------------------------------------------------------
// @desc    Log a fuel top-up & upload receipt
// @route   POST /api/fuel
// @access  Private (User)
// VIVA EXPLANATION:
// The system looks at the provided bookingId, populates the Car,
// uses req.body.litresFilled to update the estimated tank volume,
// and mathematically calculates the 'tankPercentAfter' and
// 'kmRemainingAfter' which are returned to the frontend.
// -----------------------------------------------------------
exports.logFuel = async (req, res, next) => {
  try {
    const { bookingId, litresFilled, costPaid, stationName } = req.body;

    // Validate inputs
    if (!bookingId || !litresFilled) {
      return res.status(400).json({ message: 'Booking ID and Litres Filled are required.' });
    }

    // Verify booking belongs to user
    const booking = await Booking.findOne({ _id: bookingId, user: req.user._id });
    if (!booking) {
      return res.status(404).json({ message: 'Active booking not found.' });
    }

    // Fetch Car details to get tankCapacity and kmPerLiter
    const car = await Car.findById(booking.car);
    if (!car) {
      return res.status(404).json({ message: 'Associated car not found.' });
    }

    // ----- MATH & LOGIC -----
    const parsedLitresFilled = parseFloat(litresFilled);

    // Find previous fuel log for this booking to get 'fuelLevelBefore'
    const lastFuelLog = await FuelLog.findOne({ booking: booking._id }).sort({ createdAt: -1 });

    let fuelLevelBefore = 0;
    if (lastFuelLog && lastFuelLog.fuelLevelAfter) {
      fuelLevelBefore = lastFuelLog.fuelLevelAfter;
    } else {
      // Assumption: If it's the first top-up, maybe the tank was near empty or half.
      // We will assume 10L for safety if no prior data exists. 
      // (In real life, starting fuel is noted at checkout).
      fuelLevelBefore = 10;
    }

    // Calculate new total fuel level (cap at tankCapacity so it doesn't overflow)
    let fuelLevelAfter = fuelLevelBefore + parsedLitresFilled;
    if (fuelLevelAfter > car.tankCapacity) {
      fuelLevelAfter = car.tankCapacity; // Prevent >100% bugs
    }

    const tankPercentAfter = (fuelLevelAfter / car.tankCapacity) * 100;
    const kmRemainingAfter = fuelLevelAfter * car.kmPerLiter;

    // ----- PHOTO UPLOAD -----
    let receiptPath = null;
    if (req.file) {
      const relativePath = req.file.path.split('uploads')[1].replace(/\\/g, '/');
      receiptPath = `uploads${relativePath}`;
    }

    const fuelLog = await FuelLog.create({
      booking: booking._id,
      car: car._id,
      user: req.user._id,
      litresFilled: parsedLitresFilled,
      fuelLevelBefore,
      fuelLevelAfter,
      tankPercentAfter: Math.round(tankPercentAfter),
      kmRemainingAfter: Math.round(kmRemainingAfter),
      costPaid: parseFloat(costPaid || 0),
      stationName,
      receiptPhoto: receiptPath,
    });

    res.status(201).json({
      success: true,
      message: `Your tank is now ${Math.round(tankPercentAfter)}% full. You can drive ~${Math.round(kmRemainingAfter)} more km.`,
      data: fuelLog,
    });
  } catch (error) {
    next(error);
  }
};

// -----------------------------------------------------------
// @desc    Get all fuel logs for a booking
// @route   GET /api/fuel/:bookingId
// @access  Private (User/Admin)
// -----------------------------------------------------------
exports.getFuelLogs = async (req, res, next) => {
  try {
    const logs = await FuelLog.find({ booking: req.params.bookingId })
      .sort({ createdAt: -1 })
      .populate('car', 'name licensePlate');

    res.status(200).json({
      success: true,
      count: logs.length,
      data: logs,
    });
  } catch (error) {
    next(error);
  }
};

// -----------------------------------------------------------
// @desc    Update a specific fuel log
// @route   PUT /api/fuel/:id
// @access  Private (User/Admin)
// -----------------------------------------------------------
exports.updateFuelLog = async (req, res, next) => {
  try {
    const { litresFilled, costPaid, stationName } = req.body;
    let log = await FuelLog.findById(req.params.id);

    if (!log) {
      return res.status(404).json({ message: 'Fuel log not found' });
    }

    if (log.user.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to update this log' });
    }

    // Note: We only update superficial values. The underlying 'fuelLevelAfter' 
    // requires complex math if altered retrospectively, so we expect the frontend 
    // to recalculate and PUT to Car directly when updating historical logs.
    log.litresFilled = litresFilled || log.litresFilled;
    log.costPaid = costPaid !== undefined ? costPaid : log.costPaid;
    log.stationName = stationName || log.stationName;

    await log.save();

    res.status(200).json({ success: true, data: log });
  } catch (error) {
    next(error);
  }
};

// -----------------------------------------------------------
// @desc    Delete a specific fuel log
// @route   DELETE /api/fuel/:id
// @access  Private (User/Admin)
// -----------------------------------------------------------
exports.deleteFuelLog = async (req, res, next) => {
  try {
    const log = await FuelLog.findById(req.params.id);

    if (!log) {
      return res.status(404).json({ message: 'Fuel log not found' });
    }

    if (log.user.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized to delete this log' });
    }

    await FuelLog.findByIdAndDelete(req.params.id);

    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    next(error);
  }
};

// -----------------------------------------------------------
// @desc    Download fuel report as PDF
// @route   GET /api/fuel/:bookingId/report
// @access  Private (User/Admin)
// -----------------------------------------------------------
exports.downloadFuelReport = async (req, res, next) => {
  try {
    const bookingId = req.params.bookingId;
    const logs = await FuelLog.find({ booking: bookingId }).populate('car', 'name licensePlate').sort({ createdAt: 1 });
    
    if (!logs || logs.length === 0) {
      return res.status(404).json({ message: 'No fuel logs found for this booking to generate PDF.' });
    }

    const carName = logs[0].car ? logs[0].car.name : 'Vehicle';
    
    // Create a PDF Document
    const doc = new PDFDocument({ margin: 50 });
    
    // Ensure reports directory exists
    const pdfDir = path.join(__dirname, '..', 'uploads', 'reports');
    if (!fs.existsSync(pdfDir)) {
      fs.mkdirSync(pdfDir, { recursive: true });
    }

    const pdfFilename = `FuelReport-${bookingId}-${Date.now()}.pdf`;
    const pdfPathAbs = path.join(pdfDir, pdfFilename);
    const pdfPathRel = `uploads/reports/${pdfFilename}`;

    const writeStream = fs.createWriteStream(pdfPathAbs);
    doc.pipe(writeStream);
    
    // Title
    doc.fontSize(20).text('Fuel Consumption Report', { align: 'center' });
    doc.moveDown();
    
    doc.fontSize(12).text(`Booking Reference: ${bookingId}`);
    doc.text(`Vehicle: ${carName}`);
    doc.text(`Date Generated: ${new Date().toLocaleDateString()}`);
    doc.moveDown(2);
    
    // Table Header
    doc.fontSize(12).font('Helvetica-Bold');
    doc.text('Date', 50, doc.y, { continued: true, width: 90 });
    doc.text('Litres', 140, doc.y, { continued: true, width: 70 });
    doc.text('Cost', 210, doc.y, { continued: true, width: 70 });
    doc.text('Tank %', 280, doc.y, { continued: true, width: 70 });
    doc.text('Station', 350, doc.y);
    doc.moveDown(0.5);
    
    // Line
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(0.5);
    
    // Data
    doc.font('Helvetica');
    let totalCost = 0;
    let totalLitres = 0;
    
    logs.forEach(log => {
      const dateStr = new Date(log.createdAt).toLocaleDateString();
      doc.text(dateStr, 50, doc.y, { continued: true, width: 90 });
      doc.text(`${log.litresFilled || 0} L`, 140, doc.y, { continued: true, width: 70 });
      doc.text(`$${log.costPaid || 0}`, 210, doc.y, { continued: true, width: 70 });
      doc.text(`${log.tankPercentAfter || 0}%`, 280, doc.y, { continued: true, width: 70 });
      doc.text(log.stationName || 'N/A', 350, doc.y);
      doc.moveDown(0.5);
      
      totalCost += (log.costPaid || 0);
      totalLitres += (log.litresFilled || 0);
    });
    
    doc.moveDown();
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown();
    
    // Summary
    doc.font('Helvetica-Bold');
    doc.text(`Total Litres: ${totalLitres.toFixed(1)} L`, 50, doc.y);
    doc.text(`Total Cost Spent: $${totalCost.toFixed(2)}`, 50, doc.y);
    
    doc.end();

    writeStream.on('finish', () => {
      // Return the generic URL structure compatible with the frontend Linking
      res.status(200).json({ success: true, pdfUrl: pdfPathRel });
    });
  } catch (error) {
    next(error);
  }
};
